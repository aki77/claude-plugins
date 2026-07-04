---
name: pr-review
description: 指定されたGitHubプルリクエストに対して、複数の専門エージェント（CLAUDE.md準拠/バグ検出/REVIEW.md準拠）を並列起動して多角的なコードレビューを実施するスキル。
allowed-tools: Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh repo view:*), Bash(gh api:*), Bash(git rev-parse:*), Bash(git diff:*), Bash(node:*), Bash(jq:*)
disable-model-invocation: true
---

指定されたプルリクエストに対してコードレビューを行います。

引数: `<PR>` （必須）、`--comment`（任意。指定時は GitHub にインラインコメントを投稿する）

0. **PR HEAD とローカルの一致を確認する（最初に必ず実行）。** このスキルはプロジェクトルール（`CLAUDE.md` / `.claude/rules/` / `REVIEW.md` / 観点ファイル）と `.gitattributes` をローカル作業ツリーから読み、diff もローカル `git diff` で取得するため、ローカルの HEAD が対象 PR の HEAD コミットと一致している必要がある。この確認は `--comment` 引数の有無に関わらず必須であり、一致しない場合は無条件に処理を終了する。以下を実行して照合する:
   - `gh pr view <PR> --json headRefOid --jq .headRefOid` で PR HEAD の commit sha を取得する。
   - `git rev-parse HEAD` でローカル HEAD の commit sha を取得する。
   - 両者が**完全一致しない**場合は、レビューを行わずに次の旨を報告して**処理を終了する**: 「ローカルの HEAD が PR #<PR> の HEAD（`<headRefOid>`）と一致しません（ローカル: `<localSha>`）。このスキルはルールファイルをローカルから読み diff もローカルで取得するため、対象 PR のブランチをチェックアウト（または最新化）してから再実行してください。」
   - 一致する場合のみ、以降のステップに進む。

## モード別パラメータ

`${CLAUDE_PLUGIN_ROOT}/shared/review-core.md` の**太字名**に、pr-review では以下の値を与える:

| パラメータ | 値 |
|---|---|
| **context引数** | `--pr <PR>` |
| **サマリエージェント入力** | `gh pr view <PR> --json title,body,commits --jq '{title: .title, body: .body, commits: [.commits[] \| {headline: .messageHeadline, body: .messageBody}]}'`（PRタイトル・説明文・コミットメッセージ一覧）+ 統一 diff |
| **著者意図情報** | PRタイトル・説明文 |
| **ステップ3の起動タイミング** | エージェント1・2・3・5 はステップ2と並列に起動してよい（ステップ2に依存しない）。エージェント4のみステップ2完了を待つ |
| **サマリ失敗時の縮退** | 著者意図情報（PRタイトル・説明文）は常に存在するため、`summary` が失敗してもエージェント4は PRタイトル・説明文を著者意図として起動できる |
| **既存問題の基準** | 「PR以前から」 |
| **ステップ7の追加要素と完了後の動作** | 追加要素なし（冒頭に「変更概要」は載せない）。`--comment` 指定時は下記ステップ8へ進む。未指定なら GitHub への投稿を一切行わずここで終了する |

## 実行

`${CLAUDE_PLUGIN_ROOT}/shared/review-core.md` を読み込み、上記モード別パラメータを適用してステップ1〜7を**一字一句そのとおりに実行する**。独自の追加・省略・解釈変更をしない。ルールファイル・`.gitattributes` はローカル作業ツリーから読むため、ステップ0の HEAD 一致確認が前提となっている。

ステップ7まで完了したら、`--comment` が指定されている場合のみ以下のステップ8〜10へ進む（未指定ならステップ7で終了）。`--comment` 指定時は課題の有無にかかわらずステップ8に進む（課題ゼロの場合もPRレビューとして投稿する）。

8. 投稿予定のコメント一覧を作成する。これは投稿内容を自分で確認するためのもので、どこにも投稿しないこと。各課題について以下を確定する:
   - `path`: 対象ファイルの相対パス。
   - `existingCode`: **diff 中にそのまま存在する連続した数行**（コメントを貼る位置のアンカーになる。行番号は書かない）。次を守ること:
     - diff の該当箇所からコード片を**逐語コピー**する（インデント込み。書き換え・整形をしない）。
     - suggestion で**行を削除する場合は、削除したい行と残したい行の両方をこの範囲に含める**（例: 31行目のコメントを消して32行目の `def` を残すなら、その2行を `existingCode` に含める）。
     - アンカーは diff 内で**一意に特定できる**長さにする（同一行が複数箇所にある場合は前後行も含めて曖昧さを消す）。
   - `suggestionBody`: suggestion ブロックの中身（= `existingCode` の範囲を丸ごと置き換える最終形）。**行を削除する修正では、範囲に削除行を含めつつ `suggestionBody` からその行を省く**（範囲2行→本文1行 = 実質削除）。
   - `commentBody`: suggestion ブロックを除いたコメント文（課題の概要・引用元リンク）。

9. 各課題の行番号を **スクリプトで確定する**。**行番号（`line` / `startLine`）を自分で推測して指定してはならない。** LLM が行番号を推測すると diff にマッピングできない指定（特に削除を伴う修正）になり、GitHub 側で位置解決に失敗して `line: null` 化する。手順:
   - ステップ8の各課題から `{ path, existingCode }` の配列を作り、`node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-suggestion-lines.mjs --context "$CTX"` に **stdin で JSON を渡す**（`$CTX` はステップ1で束ねた CTX ファイルパス。`existingCode` の改行は `\n` としてJSONエスケープすること）。スクリプトは CTX の `diffArgs` / `excludeArgs.git` から `git -c core.quotepath=false diff ...` を実行し、レビューに使ったのと同一の統一 diff にアンカーをマッチさせる（別ソースの diff を引き直さないため、除外ファイル・非ASCIIパス等のずれが起きない）。
   - スクリプトは各課題について diff hunk とテキストマッチして行番号を機械的に確定し、入力と同順の配列を返す:
     - `{ path, resolved: true, params: { line, startLine?, side?, startSide?, subjectType } }`: 行番号確定に成功した課題。ステップ10でこの要素に `body` を足してそのまま投稿する（`params` は分解・再構成しない）。
     - `{ path, resolved: false, reason }`: 該当箇所を diff から一意に特定できなかった課題。**インラインコメントにせず**、ステップ10のレビューサマリ本文に文章で記載する（誤った位置に貼らない）。`existingCode` が diff と逐語一致していない可能性が高いので、必要なら `existingCode` を diff に合わせて修正し再実行してもよい。

10. レビュー（サマリ + インラインコメント）を **`post-review.mjs` で一括投稿する**。GitHub REST API の `POST /pulls/{n}/reviews` を1リクエストで叩き、サマリと全インラインコメントをまとめて送信する。手順は以下:

   1. 投稿内容 JSON を組み立てる。形式は `{ summaryBody, comments: [ ...ステップ9の各要素に body を足したもの ] }`:
      - `comments`: **ステップ9の resolve 出力の配列に、対応する課題（同順・同 index）の `body` を付与しただけ**の配列。resolve 出力を組み替えたり `params` を分解・再構成したりしないこと（構造ミスを避けるため、resolve が返した要素をそのまま使い body を1つ足すだけにする）。
        - `resolved: false` の要素も**そのまま含めてよい**（post-review.mjs 側でインライン投稿対象から自動スキップされる。該当課題はサマリ本文で言及する）。
        - `path` と `params` はステップ9が返した値をそのまま保持する（`line` / `startLine` / `side` / `startSide` / `subjectType` を自分で決めない）。
        - `body`: `resolved: true` の要素にのみ付与する。`commentBody` に、必要に応じて suggestion ブロック（```suggestion ... ```、中身は `suggestionBody`）を続けたもの。方針:
          - 課題の概要を簡潔に記述する
          - 小規模で自己完結する修正の場合は、コミット可能なsuggestionブロック（```suggestion ... ```）を含める
          - 大規模な修正（6行以上、構造的変更、複数箇所にまたがる変更）の場合は、suggestionブロックは付けず、課題と修正方針を文章で記述する
          - 該当suggestionをコミットするだけで課題が完全に解消する場合に限り、コミット可能なsuggestionを投稿する。追加対応が必要な場合はsuggestionブロックを付けないこと。
          - **行を削除する修正**では、`suggestionBody` から削除対象行を省くこと（`existingCode` の範囲がその行を含んでいるので、本文から省けば削除になる）。
      - `summaryBody`: レビュー全体のサマリ（課題サマリのみで構成し、「変更概要」は載せない）:
        - 課題が見つかった場合: 検出した課題の概要を記述する。ステップ9で `resolved: false` になりインライン化できなかった課題があれば、ここに該当ファイル・箇所と内容を文章で記載する。
        - 課題が見つからなかった場合: 「問題は見つかりませんでした。バグ・プロジェクトルール（CLAUDE.md / .claude/rules/）準拠・REVIEW.md準拠を確認しました。」と記述する。
   2. この JSON を `node ${CLAUDE_PLUGIN_ROOT}/scripts/post-review.mjs --pr <PR> --commit <headRefOid>` に **stdin で渡す**（`--commit` にはステップ0で取得済みの `headRefOid` を使い、レビュー対象コミットを固定する）。スクリプトは入力を検証（`resolved:false` を自動スキップ、`resolved:true` なのに `params.line`/`body` を欠く要素はエラーで即失敗）してから `params` を REST API のフィールドへ内部変換し、`event: "COMMENT"` でレビューを1リクエスト投稿して、投稿されたレビューの URL を返す。エラーで失敗した場合は入力構造を見直して再実行する。

   **重要: 同一課題につき1コメントのみ投稿する。重複コメントを投稿しないこと。**

PR 固有の備考:

- GitHubとのやり取り（PR取得、コメント作成など）には gh CLI を使用すること。web fetch は使用しない。
- インラインコメントには各課題の引用元へのリンクを必ず含めること（例: CLAUDE.mdや `.claude/rules/` 配下のルールファイルに言及する場合はそのファイルへのリンクを含める）。
- インラインコメント内でコードへリンクする際は、以下の形式を厳密に守ること。守らないとMarkdownプレビューが正しくレンダリングされない: https://github.com/anthropics/claude-code/blob/c21d3c10bc8e898b7ac1a2d745bdc9bc4e423afe/package.json#L10-L15
  - フルのgit shaが必要。PRのHEADコミットのsha（ステップ0で取得済みの `headRefOid`）を使う。
  - フルのshaを直接記述すること。`https://github.com/owner/repo/blob/$(git rev-parse HEAD)/foo/bar` のようなコマンド埋め込みはMarkdownでそのまま描画されるため動作しない。
  - リポジトリ名（`owner/repo`）は `gh repo view --json nameWithOwner --jq .nameWithOwner` で取得し、レビュー対象のリポジトリと一致させる
  - ファイル名のあとに `#` を入れる
  - 行範囲は `L[start]-L[end]` の形式
  - コメント対象行の前後に最低1行ずつコンテキストを含める（例: 5-6行目についてコメントするなら `L4-L7` でリンクする）
