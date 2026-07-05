---
name: pr-review
description: 指定されたGitHubプルリクエストに対して、複数の専門エージェント（CLAUDE.md準拠/バグ検出/REVIEW.md準拠）を並列起動して多角的なコードレビューを実施するスキル。
allowed-tools: Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh repo view:*), Bash(gh api:*), Bash(git rev-parse:*), Bash(git diff:*), Bash(git show:*), Bash(node:*), Bash(jq:*), Write
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
| **ステップ8の追加要素と完了後の動作** | 追加要素なし（冒頭に「変更概要」は載せない）。`--comment` 指定時は下記ステップ9へ進む。未指定なら GitHub への投稿を一切行わずここで終了する |

## 実行

`${CLAUDE_PLUGIN_ROOT}/shared/review-core.md` を読み込み、上記モード別パラメータを適用してステップ1〜8を**一字一句そのとおりに実行する**。独自の追加・省略・解釈変更をしない。ルールファイル・`.gitattributes` はローカル作業ツリーから読むため、ステップ0の HEAD 一致確認が前提となっている。

ステップ8まで完了したら、`--comment` が指定されている場合のみ以下のステップ9〜10へ進む（未指定ならステップ8で終了）。`--comment` 指定時は課題の有無にかかわらずステップ9に進む（課題ゼロの場合もPRレビューとして投稿する）。行番号（`line` / `startLine` / `side`）はステップ4のスクリプトが確定済みで `FINAL` の各 issue の `params` に入っている。**行番号を自分で推測・変更してはならない。**

9. **各インラインコメントの本文を作成する。** `FINAL`（ステップ7で束ねた成果物パス）の **confirmed かつ `resolved:true` の各 issue**（`jq -c '.issues[] | select(.resolved==true)' "$FINAL"` で取得。`id`/`path`/`title`/`body`/`existingCode`/`params`/`sourceFindingIds` を含む）について、GitHub に投稿する `commentBody`（文章）と、必要なら `suggestion`（置換後の行）を作る。`resolved:false` の confirmed issue はインライン化せず、ステップ10のサマリ本文で言及する（行番号が未確定なので誤位置に貼らない）。**課題が0件（`FINAL.issues` が空）の場合はこのステップの本文作成をスキップし、ステップ10で空の `comments: []` を渡す。**

   **重要（suggestion の破壊的編集を防ぐ）:** GitHub は `params` の行範囲（＝ `existingCode` の範囲）を suggestion 本文で**丸ごと置換**する。suggestion 本文の行数が範囲より短いと、余った既存行が**削除される**。過去に「コメント指摘のはずが次行の gitignore 本体まで消えた」事故が起きたのはこのため。これを防ぐため、suggestion 本文は `existingCode` を土台に機械的に作り、`post-review.mjs` が範囲との整合を検証（不整合なら suggestion を自動で捨てて文章のみ投稿）する。以下に従うこと:

   - `commentBody`: 課題の概要を簡潔に記述する（issue の `title`/`body` を基にする。引用元リンクを含める）。**`suggestion` ブロック（```suggestion）を自分で書かない**（スクリプトが組み立てる）。
   - 小規模で自己完結する修正には `suggestion` を付けてよい。**手順:** issue の `existingCode` を `jq` で逐語取得し（`jq -r '.issues[] | select(.id=="<id>") | .existingCode' "$FINAL"`）、それを土台に**該当行だけ**を編集した最終形を作る。**変更しない行は1文字も変えずそのまま残す。** これが「範囲を丸ごと置き換える最終形」になる。
   - **行を削除する修正**（範囲から行を減らす）では、消す既存行を `deleteLines`（消してよい既存行の逐語）に**明示する**。この明示が無いと `post-review.mjs` の機械ガードが suggestion を捨てて文章のみにする。
   - **複数メンバーの統合 issue（`sourceFindingIds` が2件以上）には `suggestion` を付けない**（`existingCode` が範囲全体を表さず、機械ガードが捨てるため）。文章で修正方針を書く。
   - 大規模な修正（6行以上、構造的変更、複数箇所にまたがる変更）は `suggestion` を付けず、課題と修正方針を文章で記述する。
   - 該当 suggestion をコミットするだけで課題が完全に解消する場合に限り `suggestion` を付ける。追加対応が必要なら付けないこと。
   - **アンカー範囲（`params` の行範囲）が意図した修正に合わない場合は、`suggestion` なしの文章コメントに落とす**（行番号の再推測・再解決はしない）。

10. レビュー（サマリ + インラインコメント）を **`post-review.mjs` で一括投稿する**。GitHub REST API の `POST /pulls/{n}/reviews` を1リクエストで叩き、サマリと全インラインコメントをまとめて送信する。手順は以下:

   1. 投稿内容 JSON を組み立て、**`Write` ツールで `/tmp/code-review-payload-<PR番号>.json` に書く**（前掲 review-core.md「Bash コマンドの制約」の構造化 JSON 受け渡し則に従う。`commentBody` は日本語長文、`suggestion` はコード片で `{`/`"` を含むため、heredoc・コマンドライン・stdin には**絶対に載せない**——brace+quote で拒否される）。形式は `{ summaryBody, comments: [{ id, commentBody, suggestion?, deleteLines? }] }`:
      - `comments`: **ステップ9で本文を作った confirmed かつ `resolved:true` の各 issue につき1オブジェクト**。`id` は `FINAL` の issue の `id`（= groupId）をそのまま使う。`commentBody` は文章、`suggestion` は置換後の行（string の配列、または改行区切りの1文字列。省略可）、`deleteLines` は行削除を伴う場合に消す既存行の配列（省略可）。**`params`・`path`・`line` や ```suggestion フェンスは一切書かない**（スクリプトが `id` で `FINAL` から引き、フェンスも組み立てる）。`resolved:false` の issue は `comments` に含めない（含めるとスクリプトがエラーにする。サマリ本文で言及する）。
      - `summaryBody`: レビュー全体のサマリ（課題サマリのみで構成し、「変更概要」は載せない）:
        - 課題が見つかった場合: 検出した課題の概要を記述する。confirmed だが `resolved:false`（インライン化できなかった）issue があれば、ここに該当ファイル・箇所と内容を文章で記載する。`FINAL.rejected` / `FINAL.unverified` はサマリに載せなくてよい（ターミナル表示済み）。
        - 課題が見つからなかった場合: 「問題は見つかりませんでした。バグ・プロジェクトルール（CLAUDE.md / .claude/rules/）準拠・REVIEW.md準拠を確認しました。」と記述する。
   2. ステップ10-1 で書いた投稿内容 JSON のパスを `node ${CLAUDE_PLUGIN_ROOT}/scripts/post-review.mjs --pr <PR> --commit <headRefOid> --issues "$FINAL" --infile <書いたパス>` として渡す（`--commit` にはステップ0で取得済みの `headRefOid` を使い、レビュー対象コミットを固定する。`--issues` にはステップ7で束ねた `FINAL` のパスを渡す）。スクリプトは入力を検証（未知/重複 id・`resolved:false` の id をコメントに含めた・`resolved:true` の confirmed issue がコメントに欠落＝黙殺・`commentBody` 空はいずれもエラーで即失敗。resolved 済み issue が0件ならサマリのみ投稿を許容）してから `id` で `FINAL` の `params`/`existingCode` を結合する。`suggestion` は範囲との整合を機械検証し、**破壊的（行削除が起きるのに `deleteLines` 未明示・範囲行数不一致・統合 issue など）なら suggestion を自動で捨てて文章のみ投稿する**（エラーにはせず、コードを消さない）。REST API のフィールドへ内部変換して `event: "COMMENT"` でレビューを1リクエスト投稿し、投稿されたレビューの URL を返す。エラーで失敗した場合は入力を見直して再実行する。

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
