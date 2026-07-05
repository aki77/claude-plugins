# code-review

GitHub のプルリクエスト、またはローカルの git 差分に対して、複数の専門サブエージェントを並列起動し、CLAUDE.md準拠・バグ検出・REVIEW.md準拠の3観点から多角的なコードレビューを行うプラグインです。

- `pr-review`: 指定した GitHub PR をレビュー（`--comment` 指定時はインラインコメントを投稿）
- `local-review`: ローカルの git 差分（ステージ済み変更・任意の range）をレビュー（PR作成前のセルフレビュー用）

## しくみ

`pr-review` と `local-review` は、共通レビューパイプライン [`shared/review-core.md`](shared/review-core.md) を読み込み、それぞれのモード別パラメータ（diff の取得方法・著者意図情報の取り方など）を適用して同一の手順で実行されます。

パイプラインは「**LLM は課題の発見・文章化・検証判定を、コードは位置解決・重複統合・フィルタ適用・構造転写を担う**」という役割分担に従っており、各ステップの成果物は一時ファイルに JSON で保存され、パスだけが次のステップに渡されます（中間成果物チェーン: `CTX → CLUSTERS → FINDINGS → ISSUES → FINAL`）。

主なエージェント構成:

| エージェント | 役割 | モデル |
| --- | --- | --- |
| 1・2 | プロジェクトルール（CLAUDE.md / `.claude/rules/`）準拠チェック | Sonnet |
| 3 | バグ検出（diff限定） | Opus |
| 4 | バグ検出／クロスファイル整合性チェック（影響クラスタごとに並列起動） | Opus |
| 5 | `REVIEW.md` 準拠チェック | Sonnet |
| 検証エージェント | 各課題（issue）が実際に問題かを検証 | 課題の種類に応じて Opus/Sonnet |

変更規模（`tier`: `tiny` / `small` / `normal`）に応じて、サマリ生成やエージェント起動数が自動的に縮退し、小さな変更ではレビューが速く安く終わるようになっています。

## カスタマイズ

プラグイン内の Markdown（`shared/review-core.md` や各 `SKILL.md`）は直接編集できません。レビュー観点をカスタマイズしたい場合は、リポジトリのルート直下に `REVIEW.md` を置いてください。エージェント5がそこに記載された観点への新規違反を監査します（CLAUDE.md / `.claude/rules/` によるプロジェクトルール準拠チェックとは別軸です）。

## インストール

```
/plugin marketplace add aki77/claude-plugins
/plugin install code-review@plugin-hub
```

## 使い方

```
/code-review:pr-review <PR番号> [--comment]
/code-review:local-review [<range>]
```

- `pr-review` はローカルの HEAD が対象 PR の HEAD コミットと一致している必要があります（ルールファイル・diff をローカル作業ツリーから読むため）。一致しない場合はチェックアウトしてから再実行してください。`--comment` を指定すると、レビュー結果を GitHub にインラインコメント＋サマリとして投稿します（未指定ならターミナル出力のみ）。
- `local-review` の `<range>` は省略可能です:
  - 引数なし: ステージ済み変更（`git diff --staged`）があればそれを優先。なければブランチ設定から base を自動解決（`github-pr-base-branch` → `vscode-merge-base` → `@{upstream}` → `origin/HEAD` の順）
  - `main`: `main...HEAD` として補完
  - `main...HEAD` / `main..HEAD` / `abc123..def456`: そのまま使用

## 設定

[`scripts/collect-review-context.mjs`](scripts/collect-review-context.mjs) が変更規模の `tier`（`tiny` / `small` / `normal`）判定としきい値超過ファイルの除外に使う環境変数です。

| 環境変数 | 説明 | デフォルト |
| --- | --- | --- |
| `CODE_REVIEW_TINY_MAX_FILES` | `tiny` 判定の最大ファイル数 | `2` |
| `CODE_REVIEW_TINY_MAX_LINES` | `tiny` 判定の最大変更行数 | `50` |
| `CODE_REVIEW_SMALL_MAX_FILES` | `small` 判定の最大ファイル数 | `5` |
| `CODE_REVIEW_SMALL_MAX_LINES` | `small` 判定の最大変更行数 | `150` |
| `CODE_REVIEW_OVERSIZED_MAX_LINES` | この行数を超える変更ファイルはレビュー対象外（`oversizedFiles`）にする | `1000` |

## 前提

- `node`（スクリプト実行）
- `jq`（中間成果物からの値取り出し）
- `gh` CLI（`pr-review` での PR 情報取得・コメント投稿）

## 動作確認

`/code-review:local-review` をステージ済み変更、または適当な range（例: `main`）に対して実行し、ステップ1〜8の処理（コンテキスト収集 → サマリ/クラスタ分割 → レビューエージェント起動 → 集約 → 検証 → サマリ表示）が完了し、検出した課題（または「問題は見つかりませんでした」）がターミナルに表示されることを確認します。

### スクリプトの単体テスト

各 `.mjs` にはインラインテストが埋め込まれています。以下で実行します（`node --test` は "run() called recursively" 警告が出て正しく走らないため使わないでください）:

```bash
NODE_TEST_CONTEXT=1 node plugins/code-review/scripts/collect-review-context.mjs
```

## 既知の制限

- レビューの質はサブエージェントの判断に依存します。
- headless（`claude-code-action` 等の非対話実行）では Bash permission の静的解析により `$(...)` コマンド置換・パイプ・複合コマンドが拒否されるため、diff 取得は `emit-diff.mjs` に、構造化 JSON の受け渡しは `Write` ツール + `--infile` に、それぞれ経路が固定化されています（詳細は [`shared/review-core.md`](shared/review-core.md) の「Bash コマンドの制約」を参照）。
- `pr-review` はローカル HEAD が対象 PR の HEAD と一致していない場合、レビューを行わずに終了します。
