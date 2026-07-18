# plan-visualize

Plan モードでプランファイルを作成する際の**視覚化ルール（Mermaid 図・表）**を、`UserPromptSubmit` フックでコンテキストに自動注入するプラグインです。

Plan モードで作られるプランは、手順・フロー・構成・依存関係などを含みがちですが、放っておくと文章の羅列になりやすく読みにくくなります。このプラグインは `permission_mode` が `"plan"` のときだけ、視覚化のルールを `additionalContext` として注入し、プランを Mermaid 図や表で構造的に表現するよう促します。**Plan モード以外（通常モード）では何も出力せず副作用ゼロ**です。

## しくみ

1. `UserPromptSubmit` イベントで、フックが stdin から `{ permission_mode, prompt, ... }` を受け取る（matcher なし、全プロンプトで発火）
2. `permission_mode !== "plan"` なら何も出力せず `exit 0`。JSON パースに失敗した場合も同様に `exit 0`
3. `"plan"` のときは、視覚化ルールを以下の形式で出力する:
   ```json
   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<ルール本文>" } }
   ```

実装は `jq` を用いたシェルスクリプト 1 本（`hooks/inject-rules.sh`）です。

## 注入されるルール本文

```
# プランファイル作成時の視覚化ルール
- 手順・フロー・構成・スケジュールなど、順序や関係が本質の内容はマーメイド図で視覚化する。
- 比較・列挙は表にする。
- マーメイド図は壊れにくさを優先する: ノードやサブグラフのラベルに `/ : @ () " <> #` などの記号や先頭記号が入る場合は必ずダブルクォートで囲む（例: `A["/code-review:pr-review Skill"]`）。可能なら記号自体を避け、英数字・スペース・日本語で言い換える。
- サブグラフは原則使わず、エッジラベルは記号を含まない短い語にする。図が大きく複雑になるなら、無理に1枚に収めず複数の図に分割する。
```

## インストール

```
/plugin marketplace add aki77/claude-plugins
/plugin install plan-visualize@plugin-hub
```

## 前提

- `jq`（stdin の JSON パースと出力 JSON の生成に使用）

## 関連プラグイン

- [`plan-workflow`](../plan-workflow) — Plan モードの運用ルール（要件インタビュー・実装の Agent 委譲・モデル振り分け）注入と、`ExitPlanMode` 承認直前の mo プレビューを担う。視覚化ルールはもともと plan-workflow に含まれていたが、関心の分離のため本プラグインに切り出した。両者は独立して有効化でき、併用時は運用ルールと視覚化ルールがそれぞれ別フックから注入される。

## 注意

- `hooks.json` はセッション起動時に読み込まれるため、プラグインをアップデートしても実行中のセッションには反映されません。反映するには Claude Code を再起動してください。
