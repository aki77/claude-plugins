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

## インストール

### 前提条件

- [Claude Code](https://claude.com/claude-code) がインストール済みであること
- Git 環境がセットアップ済みであること

## ライセンス

MIT License
