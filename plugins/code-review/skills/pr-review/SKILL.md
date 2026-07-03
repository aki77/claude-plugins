---
name: pr-review
description: 指定されたGitHubプルリクエストに対して、複数の専門エージェント（CLAUDE.md準拠/バグ検出/REVIEW.md準拠）を並列起動して多角的なコードレビューを実施するスキル。
allowed-tools: Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh repo view:*), Bash(git rev-parse:*), Bash(git diff:*), Bash(node:*), Bash(jq:*), mcp__github__create_pending_pull_request_review, mcp__github__add_comment_to_pending_review, mcp__github__submit_pending_pull_request_review
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
| **サマリ失敗時の縮退** | ステップ7の「変更概要」はサマリが得られていればそれを、失敗していれば PRタイトル・説明文で代替する |
| **既存問題の基準** | 「PR以前から」 |
| **ステップ7の追加要素と完了後の動作** | 冒頭に「変更概要」を載せる。`--comment` 指定時は下記ステップ8へ進む。未指定なら GitHub への投稿を一切行わずここで終了する |

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
   - ステップ8の各課題から `{ path, existingCode }` の配列を作り、`node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-suggestion-lines.mjs --pr <PR>` に **stdin で JSON を渡す**（`existingCode` の改行は `\n` としてJSONエスケープすること）。
   - スクリプトは各課題について diff hunk とテキストマッチして行番号を機械的に確定し、入力と同順の配列を返す:
     - `{ resolved: true, params: { line, startLine?, side?, startSide?, subjectType } }`: `params` をそのまま `add_comment_to_pending_review` に渡す。
     - `{ resolved: false, reason }`: 該当箇所を diff から一意に特定できなかった課題。**インラインコメントにせず**、ステップ10のレビューサマリ本文に文章で記載する（誤った位置に貼らない）。`existingCode` が diff と逐語一致していない可能性が高いので、必要なら `existingCode` を diff に合わせて修正し再実行してもよい。

10. Pending Review 方式でレビューを投稿する。手順は以下:

   1. `mcp__github__create_pending_pull_request_review` で pending レビューを作成する。
   2. ステップ9で `resolved: true` になった各課題について `mcp__github__add_comment_to_pending_review` でインラインコメントを追加する。該当課題ゼロの場合はこのステップをスキップする。
      - `line` / `startLine` / `side` / `startSide` / `subjectType` には**スクリプトが返した `params` の値をそのまま使う**（自分で決めない）。
      - `body` は `commentBody` に、必要に応じて suggestion ブロック（```suggestion ... ```、中身は `suggestionBody`）を続けたもの。
      - `body` の方針:
        - 課題の概要を簡潔に記述する
        - 小規模で自己完結する修正の場合は、コミット可能なsuggestionブロック（```suggestion ... ```）を含める
        - 大規模な修正（6行以上、構造的変更、複数箇所にまたがる変更）の場合は、suggestionブロックは付けず、課題と修正方針を文章で記述する
        - 該当suggestionをコミットするだけで課題が完全に解消する場合に限り、コミット可能なsuggestionを投稿する。追加対応が必要な場合はsuggestionブロックを付けないこと。
        - **行を削除する修正**では、`suggestionBody` から削除対象行を省くこと（`existingCode` の範囲がその行を含んでいるので、本文から省けば削除になる）。
   3. `mcp__github__submit_pending_pull_request_review` を `event: "COMMENT"` で送信する。`body` にはレビュー全体のサマリを含める:
      - 冒頭に、ステップ2のサマリエージェント出力を「変更概要」として簡潔に載せる（サマリが失敗していた場合は PRタイトル・説明文で代替する）。
      - 課題が見つかった場合: 検出した課題の概要を記述する。ステップ9で `resolved: false` になりインライン化できなかった課題があれば、ここに該当ファイル・箇所と内容を文章で記載する。
      - 課題が見つからなかった場合: 「問題は見つかりませんでした。バグ・プロジェクトルール（CLAUDE.md / .claude/rules/）準拠・REVIEW.md準拠を確認しました。」と記述する。

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
