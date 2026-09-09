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

### plan-workflow

Plan モードの運用ルール（要件インタビュー・実装の Agent 委譲・モデル振り分け・依頼とプランの妥当性検証）を `UserPromptSubmit` で自動注入するプラグインです。プランの視覚化ルールは [plan-visualize](#plan-visualize) に分離されており、併用したい場合はそちらも合わせてインストールしてください。

**動作の仕組み:**
- `UserPromptSubmit` フックが `permission_mode` を確認し、`"plan"` のときだけ運用ルール（妥当性検証・インタビュー徹底・実装の Agent 委譲・モデル振り分け）を `additionalContext` として注入（通常モードは副作用ゼロ）
- 妥当性検証ルールには、依頼・プランの過剰実装や不要スコープのチェックに加え、大規模な実装をフェーズ分割してドキュメント化してから進める方針を含む
- `exit 0` で返し、プランの承認フローには一切関与しない
- Stop フックが、plan モード起点（`ExitPlanMode` 承認済み）のセッションでのみ、コード変更が10行以上あり `/simplify` 未実行なら Stop をブロックして `/simplify` を促す（doc・設定・lock・画像ファイルは変更行数の集計から除外）

**前提条件:**
- `jq` と `git` が `PATH` に存在すること

詳細は [plugins/plan-workflow](plugins/plan-workflow) を参照してください。

### plan-visualize

Plan モードでプランファイルを作成する際の視覚化ルール（Mermaid 図・表）を `UserPromptSubmit` で自動注入するプラグインです。手順・フロー・構成など順序や関係が本質の内容を、文章の羅列ではなく図や表で構造的に表現するよう促します。

**動作の仕組み:**
- `UserPromptSubmit` フックが `permission_mode` を確認し、`"plan"` のときだけ視覚化ルールを `additionalContext` として注入（通常モードは副作用ゼロ）
- ルールにはマーメイド図が壊れにくくなる書き方（記号を含むラベルのダブルクォート化、サブグラフを避けるなど）のガイドを含む

**前提条件:**
- `jq` が `PATH` に存在すること

詳細は [plugins/plan-visualize](plugins/plan-visualize) を参照してください。

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

### usage-guard

`UserPromptSubmit` と `PostToolBatch` の2フックで、Claude のサブスクリプション枠（5時間枠・週次枠）の消費率を監視し、設定した閾値を超えたら次のモデル呼び出しを止めるプラグインです。無人で回すエージェントループが、気づかないうちに使用量クレジットを消費し尽くすのを防ぎます。保証ではなく自衛用の速度制限であり、実行中のターンそのものを止めることはできません。

**動作の仕組み:**
- `UserPromptSubmit` フックと `PostToolBatch` フックが、それぞれのタイミングで現在の使用率を確認
- 使用量は OAuth 使用量エンドポイント（`api.anthropic.com/api/oauth/usage`）から取得し、プラグイン専用のデータディレクトリ（`${CLAUDE_PLUGIN_DATA}`）の `cache.json` にキャッシュ（既定 TTL：60秒）。このエンドポイントは推論クォータを消費しない
- 認証は Claude Code が保存済みの OAuth トークンを再利用（macOS は Keychain、フォールバックは `~/.claude/.credentials.json`）。API キーの設定は不要
- 5時間枠・週次枠のいずれかが閾値を超えた場合、`mode` が `enforce` なら次のモデル呼び出しを停止する。`dry-run` なら停止せず、`UserPromptSubmit` では画面に警告を出し、`PostToolBatch` では（毎バッチ通知になるのを避けるため）ログにのみ記録する
- 時限バイパスを設定すると、一定時間だけ停止判定を無効化できる

**前提条件:**
- `node` が `PATH` に存在すること
- 使用量エンドポイントが応答するアカウント（Pro / Max / Team シート）であること

**設定:**
- `~/.claude/usage-guard.json` — `mode`: `off` / `dry-run`（既定）/ `enforce`。ユーザーが編集する設定はここ、キャッシュ等の状態ファイルは `${CLAUDE_PLUGIN_DATA}` 配下に分離している

詳細は [plugins/usage-guard](plugins/usage-guard) を参照してください。

## インストール

### 前提条件

- [Claude Code](https://claude.com/claude-code) がインストール済みであること
- Git 環境がセットアップ済みであること

## ライセンス

MIT License
