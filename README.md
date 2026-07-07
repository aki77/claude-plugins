# Claude Plugins

Claude Code 用のカスタムプラグインコレクションです。

## 概要

このリポジトリは Claude Code の機能を拡張するプラグインを提供します。各プラグインは開発ワークフローを強化する独自の機能を備えています。

## プラグイン一覧

### rules-on-create

`.claude/rules/` 内のパスベースルール（`paths:` フロントマターあり）と CLAUDE.md のパス指定インストラクションを、ファイル読み込み時だけでなく Claude が**新規ファイルを作成**するときにも適用させるプラグインです。[anthropics/claude-code#23478](https://github.com/anthropics/claude-code/issues/23478) のワークアラウンドです。

**動作の仕組み:**
- `Write` への PreToolUse フックが、存在しないファイルへの書き込みをインターセプト
- ファイルを空で作成し、先に Read するよう Claude に指示して Write を拒否
- Read 後にパスベースのルールが注入され、Claude はルールをコンテキストに持った状態で Write/Edit を実行

**前提条件:**
- `jq` が `PATH` に存在すること

詳細は [plugins/rules-on-create](plugins/rules-on-create) を参照してください。

### package-manager-enforcer

プロジェクトで検出されたパッケージマネージャーと異なるコマンドの実行をブロックするプラグインです（例：`pnpm` ベースのプロジェクトで `npm install` を実行しようとした場合）。

**動作の仕組み:**
- `Bash` への PreToolUse フックがすべての Bash コマンドをインターセプト
- `package.json#packageManager` フィールドまたはロックファイルからプロジェクトのパッケージマネージャーを検出
- コマンドのマネージャーが検出されたものと異なる場合、exit 2 でブロック
- `npx` は常に許可、パッケージマネージャー以外のコマンドはそのまま通過

**前提条件:**
- `node` が `PATH` に存在すること

詳細は [plugins/package-manager-enforcer](plugins/package-manager-enforcer) を参照してください。

### plan-rule-review

プランモードを終了する前に、プロジェクトルール（CLAUDE.md / `.claude/rules/`）への準拠状況をレビューするプラグインです。実装開始前にルール違反を検出するのに役立ちます。

**動作の仕組み:**
- `ExitPlanMode` への PreToolUse フックがプランの確定をインターセプト
- 終了を拒否してレビュー指示を Claude のコンテキストに注入
- Claude が CLAUDE.md と `.claude/rules/` ファイルを読み込み、プランの違反箇所をレビュー
- 違反が見つかった場合、Claude はプランを修正して `ExitPlanMode` を再試行
- 設定した回数のレビュー後（デフォルト：2回）は常に終了が許可される

**前提条件:**
- `node` が `PATH` に存在すること

**設定:**
- `PLAN_RULE_REVIEW_MAX` — セッションあたりの最大レビュー回数（デフォルト：`2`、`0` で無効化）

詳細は [plugins/plan-rule-review](plugins/plan-rule-review) を参照してください。

### plan-rubocop-review

プランモードを終了する前に、プラン本文中の Ruby コードブロックを RuboCop（`--stdin`）で検証するプラグインです。実装開始前にプラン内のコード例の問題を検出するのに役立ちます。

**動作の仕組み:**
- `ExitPlanMode` への PreToolUse フックがプランの確定をインターセプト
- プラン本文からバッククォートフェンスの Ruby コードブロックを抽出し、RuboCop（`--stdin`）で検証
- ブート時間削減のため RuboCop は server mode で実行
- 違反が見つかった場合は deny し、プラン内コードの修正を促す
- 設定した回数のレビュー後（デフォルト：2回）は常に終了が許可される

**前提条件:**
- `node` が `PATH` に存在すること
- 検証先プロジェクトで `bundle exec rubocop` が利用可能であること（Gemfile に rubocop が含まれる）

**設定:**
- `PLAN_RUBOCOP_REVIEW_MAX` — セッションあたりの最大レビュー回数（デフォルト：`2`、`0` で無効化）

詳細は [plugins/plan-rubocop-review](plugins/plan-rubocop-review) を参照してください。

### plan-archive

古くなったプランファイルを `archived/` サブディレクトリへ自動的に退避させるプラグインです。プランディレクトリが古いファイルで散らからないように整理します。

**動作の仕組み:**
- Stop フックが transcript の `planFilePath`（plan_mode attachment）からプランディレクトリを特定
- そのディレクトリ直下で mtime が 30 日以上前の `.md` プランファイルを抽出
- 対象ファイルを `archived/` サブディレクトリへ移動し、ファイル名に最終更新日時の prefix（`YYYY-MM-DD_HHMM`）を付与
- 同名衝突時は連番サフィックスを付けて回避
- 無限ループを防ぐため `stop_hook_active` が `true` の場合はスキップ

**前提条件:**
- `node` が `PATH` に存在すること

詳細は [plugins/plan-archive](plugins/plan-archive) を参照してください。

### auto-simplify-hook

変更行数が10行以上あり、かつ現在のセッションで `/simplify` が実行されていない場合に Claude の停止をブロックするプラグインです。タスク完了前にコードのシンプル化を促します。

**動作の仕組み:**
- Stop フックが `git diff HEAD --numstat` で変更行数（追加 + 削除）をカウント
- 変更が10行以上かつトランスクリプトに `/simplify` が見つからない場合、`decision: block` を返す
- 無限ループを防ぐため `stop_hook_active` が `true` の場合はスキップ
- git 管理外のディレクトリではスキップ

**前提条件:**
- `jq` が `PATH` に存在すること
- `git` が `PATH` に存在すること

詳細は [plugins/auto-simplify-hook](plugins/auto-simplify-hook) を参照してください。

### code-review

CLAUDE.md準拠・バグ検出・REVIEW.md準拠の観点から多角的なコードレビューを行うプラグインです。GitHub PRとローカルブランチの2つのスキルを提供します。

#### `/code-review:pr-review` — GitHub PRレビュー

**動作の仕組み:**
- `/code-review:pr-review <PR番号>` で起動
- `gh pr diff` でPRの変更内容を取得し、関連するプロジェクトルール（CLAUDE.md / `.claude/rules/`）を収集
- PRタイトル・説明文・コミットメッセージ本文からサマリを生成し、変更のWHYをコンテキストとしてエージェントに渡す
- 5つのエージェントを並列起動してレビュー（CLAUDE.md準拠×2・バグ検出×2・REVIEW.md準拠×1）
- 各エージェントが検出した課題をサブエージェントで検証し、誤検知を除去
- `--comment` オプション指定時はGitHub Pending Review形式でインラインコメントを投稿

**前提条件:**
- `gh` CLI が `PATH` に存在し、GitHubに認証済みであること
- GitHub MCP サーバーが設定済みであること（`--comment` 使用時）

#### `/code-review:local-review` — ローカルブランチレビュー

PR作成前のローカルブランチ変更を対象にレビューします。

**動作の仕組み:**
- `/code-review:local-review [<range>]` で起動（例: `/code-review:local-review main`）
- 引数省略時はブランチ設定から base を自動解決（`github-pr-base-branch` → `vscode-merge-base` → `@{upstream}` → `origin/HEAD` の順）
- `git diff <range>` で差分を取得。コミットメッセージ本文も参照して変更のWHYをコンテキストに反映
- レビューロジックは `pr-review` と同等（5エージェント並列 + 検証）
- GitHub投稿は行わず、ターミナルへのサマリ出力のみ

**前提条件:**
- `git` が `PATH` に存在すること

詳細は [plugins/code-review](plugins/code-review) を参照してください。

### compact-handoff

`PreCompact` と `SessionStart(compact)` の2フックで、圧縮（コンパクション）時に標準の要約が落としがちな判断の経緯（却下した選択肢、未実行の手順上の約束、今後を縛る制約など）を `claude -p` に抽出させ、次の会話に `additionalContext` として注入するプラグインです。

**動作の仕組み:**
- `PreCompact` フックが圧縮前に transcript の未処理分（前回処理済み行数からの差分）を取り出す
- 抜き出したログ本文を `claude -p --model <model>`（ツール権限なし・読み取り専用の抽出者として）に渡し、標準要約と重複しない5カテゴリ（不採用の選択肢と理由／未実行の手順決定／制約・原則／plan mode 等のタスク状態／その他失われやすい具体値）だけを抽出させる
- 抽出結果と処理済み行数を state ファイル（`${CLAUDE_PLUGIN_DATA}/<session_id>.json`）に保存
- 圧縮完了後に発火する `SessionStart(compact)` フックが保存済みの結果を読み、`additionalContext`（モデルへ注入）と `systemMessage`（画面表示）を出力
- 両フックとも処理の成否にかかわらず `exit 0` で返し、圧縮やセッション開始自体は止めない
- 付属の `compact-handoff-status` スキルで、直近に注入された内容をいつでも再確認できる

**前提条件:**
- `claude -p` の実行に Claude Code のサブスクリプション（Max プランなど）が必要（API キーは不要）
- `node` が `PATH` に存在すること

**設定:**
- `COMPACT_HANDOFF_DEBUG` — 真の値でステップログを出力（デフォルト：無効）
- `COMPACT_HANDOFF_DEBUG_FILE` — デバッグログの出力先（デフォルト：`<tmpdir>/compact-handoff-debug.log`）
- `COMPACT_HANDOFF_MODEL` — `claude -p` に渡すモデル（デフォルト：`sonnet`）

詳細は [plugins/compact-handoff](plugins/compact-handoff) を参照してください。

## インストール

### 前提条件

- [Claude Code](https://claude.com/claude-code) がインストール済みであること
- Git 環境がセットアップ済みであること

## ライセンス

MIT License
