# plan-workflow

Plan モードの運用ルール（要件インタビュー・実装の Agent 委譲・モデル振り分け）を、`UserPromptSubmit` フックでコンテキストに自動注入するプラグインです。

Plan モードでは、要件インタビューを尽くさない・実装をメインセッションで直接行ってしまう・モデル振り分けが場当たり的になる、といった運用のブレが起きがちです。このプラグインは `UserPromptSubmit` フックで `permission_mode` を確認し、`"plan"` のときだけ運用ルールを `additionalContext` として注入します。**Plan モード以外（通常モード）では何も出力せず副作用ゼロ**です。

> プランの視覚化ルール（Mermaid 図・表）の注入は [`plan-visualize`](../plan-visualize) プラグインに、`ExitPlanMode` 承認ダイアログ直前のプランファイル mo プレビューは [`plan-preview`](../plan-preview) プラグインに、それぞれ分離しています。併用したい場合はそちらも合わせてインストールしてください。

## しくみ

1. `UserPromptSubmit` イベントで、フックが stdin から `{ permission_mode, prompt, ... }` を受け取る（matcher なし、全プロンプトで発火）
2. `permission_mode !== "plan"` なら何も出力せず `exit 0`
3. `"plan"` のときは、運用ルールの文字列を組み立てて以下の形式で出力する:
   ```json
   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<ルール本文>" } }
   ```
4. 何が起きても最終的に `exit 0`

## 注入されるルール本文

```
# Plan モード運用ルール（このセッションで必ず適用する）
1. 妥当性検証: ユーザーの依頼を受けた時点とプラン確定前の両方で以下を点検し、
   問題があれば実装を進める前にユーザーに提起する。
   - 正しい問題か: 目的に照らして不要・過剰な実装(YAGNI・過剰設計・使われないコード)に
     なっていないか、スコープが広すぎ／狭すぎないか、別の場所で解くべき問題ではないか。
     依頼そのものが本当に必要な変更かも問う。
   - 正しいアプローチか: 目的に対し手段が妥当か、既存の仕組み・パターン・ユーティリティで
     解けるものを再発明していないか、より単純で保守しやすい代替がないか、設計の
     トレードオフが妥当か。実装量が大規模・多領域に及ぶと見込まれる場合は、単一プランに
     詰め込まず複数フェーズに分割し、各フェーズの内容をまずドキュメントファイルに書き出して
     から段階的に進めることを提案する。
   迷ったら含めず、必要になった時点で追加する。
2. インタビュー: 初回プロンプトの後、要件の曖昧な点がなくなるまで AskUserQuestion で
   繰り返し質問する。1ラウンドで打ち切らず、回答から新たな曖昧点が生じたら追加で質問する。
3. 実行の委譲: ExitPlanMode 承認後、メインセッションではファイル編集・実装コマンドを
   直接実行しない。通常タスクは Agent ツール（model は 4. の基準で扱う）に移譲する。
   メインセッションの役割はタスク分割・指示・結果の検収・統合・報告のみ。
   例外: 会話全体の文脈を把握していないと実施できないタスク（plan 全体との整合が必要な
   統合・最終調整など）に限りメインセッションで実施してよい。それ以外の実装作業を
   メインセッションで行うことは不可。
4. モデル振り分け: 汎用エージェント（general-purpose 等）は model を明示し、基本は sonnet、
   設計判断・複雑なデバッグ・広範囲の変更など高難度タスクは opus を指定する。plan 策定の
   ための調査・設計サブエージェント（Explore / Plan）には opus を使う。カスタムエージェント
   は model を渡さず frontmatter の定義に任せる。上書きしてよいのは高難度タスクで opus に
   引き上げる場合のみで、sonnet への引き下げ上書きはしない。
```

## インストール

```
/plugin marketplace add aki77/claude-plugins
/plugin install plan-workflow@plugin-hub
```

## 前提

- `jq`（stdin の JSON パースと出力 JSON の生成に使用）

## 関連プラグイン

- [`plan-visualize`](../plan-visualize) — プランファイル作成時の視覚化ルール（Mermaid 図・表）を注入する。
- [`plan-preview`](../plan-preview) — `ExitPlanMode` 承認ダイアログ直前に、プランファイルを `mo`（Markdown ビューア）でブラウザに開く。

## 元記事との差分

本プラグインの運用ルール注入は [Plan モードのループを改善する記事](https://zenn.dev/k_yoshiya/articles/claude-code-plan-mode-loop) の手法を踏まえていますが、以下の点で異なります。

- 実装の委譲は `claude --bg` / `claude -p` の別プロセス起動ではなく、Agent ツールへの一本化で行う
- plan 策定のための調査・設計サブエージェント（Explore / Plan）には opus を使う
- プラン確定シグナル（`<!-- render -->` マーカー）と HTML render 機構は採用しない。プラン確認は [`plan-preview`](../plan-preview) プラグインの `PermissionRequest(ExitPlanMode)` の mo プレビューで代替しているため不要

## 注意

- `hooks.json` はセッション起動時に読み込まれるため、プラグインをアップデートしても実行中のセッションには反映されません。反映するには Claude Code を再起動してください。
