# plan-workflow

Plan モードの運用ルール（要件インタビュー・策定サブエージェントのモデル振り分け）を、`UserPromptSubmit` フックでコンテキストに自動注入するプラグインです。あわせて `ExitPlanMode` の `PreToolUse` prompt フックで、プランに実装フェーズ用スキル（`plan-implementation`）の記載があるかを判定し、記載を促します。実装後の `/simplify` 実行は、`plan-implementation` スキルの手順に含まれます。

Plan モードでは、要件インタビューを尽くさない・実装をメインセッションで直接行ってしまう・モデル振り分けが場当たり的になる、といった運用のブレが起きがちです。このプラグインは `UserPromptSubmit` フックで `permission_mode` を確認し、`"plan"` のときだけ plan 策定用の運用ルールを `additionalContext` として注入します。**Plan モード以外（通常モード）では何も出力せず副作用ゼロ**です。

**実装フェーズの運用ルール（実行の委譲・実装エージェントのモデル振り分け・実装後の `/simplify` 実行・コミット禁止）は [`plan-implementation`](skills/plan-implementation/SKILL.md) スキルに分離しています。** `UserPromptSubmit` はプラン策定中にのみ関わるため、承認後の実装フェーズでしか効かないルールをここに含めるとコンテキストを圧迫します。スキルは自動ロードが保証されないため、`inject-rules.sh` はプラン本文に「実装は `plan-implementation` スキルに従う」旨を明記するよう促し、さらに `ExitPlanMode` の `PreToolUse` prompt フックが記載の有無を検問します（詳細は後述）。

> プランの視覚化ルール（Mermaid 図・表）の注入は [`plan-visualize`](../plan-visualize) プラグインに、`ExitPlanMode` 承認ダイアログ直前のプランファイル mo プレビューは [`plan-preview`](../plan-preview) プラグインに、それぞれ分離しています。併用したい場合はそちらも合わせてインストールしてください。

## しくみ（UserPromptSubmit）

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
3. 策定サブエージェントのモデル: plan 策定のための調査・設計サブエージェント
   （Explore / Plan）には opus を使う。
4. スキル記載: 実装（コード変更・ファイル編集）を伴う計画では、プラン本文に
   「実装は plan-implementation スキルに従う」旨を明記する。実装フェーズの運用ルール
   （実行の委譲・実装エージェントのモデル振り分け・コミット禁止）は同スキルが保持する。
```

実装フェーズの運用ルール（実行の委譲・実装エージェントのモデル振り分け・実装後の `/simplify` 実行・コミット禁止）は [`plan-implementation`](skills/plan-implementation/SKILL.md) スキルの本文を参照してください。

## PreToolUse(ExitPlanMode) prompt フック

`ExitPlanMode` が呼ばれるたびに、`PreToolUse` の prompt フックがプラン本文（`$TOOL_INPUT` の `plan`）を LLM に読ませ、次を判定します。

- 実装（コード変更・ファイル編集）を伴わない計画（調査・情報収集のみ等）なら、記載の有無にかかわらず allow。
- 実装を伴う計画で、プラン本文に「実装は `plan-implementation` スキルに従う」旨の記載があれば allow。
- 実装を伴う計画なのにその記載がなければ deny し、reason で「記載を追記して再度 ExitPlanMode を呼べ」と促す。

この判定は**マーカー行（`<!-- -->` 等）の機械的な includes 判定ではなく、LLM がプラン本文を読んで文脈から判断する方式**です。マーカーという人工物をプランに残さず、「実装は `plan-implementation` スキルに従う」という自然文だけで通ります。

**既知の制限**: prompt フックはセッション状態を持たないため、command フック + `sessions.json` のような確実な回数上限（無限ループ防止のための呼び出し回数管理）は設けられません。実用上は、Claude が deny の reason に従って1回の追記で再送するため無限ループにはなりにくいですが、理論上は繰り返し deny される可能性がある点に留意してください。

## 実装後の `/simplify`

実装フェーズ完了後の `/simplify` 実行は [`plan-implementation`](skills/plan-implementation/SKILL.md) スキルの手順に含まれます。以前は `Stop` フックで機械的に促していましたが、`/simplify` の後段に別処理（レビュー等）を差し込む拡張を見据え、状態を持てず順序制御が難しいフック方式から、一連の流れを表現できるスキル手順方式へ移しました。

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

## 注意

- `hooks.json` はセッション起動時に読み込まれるため、プラグインをアップデートしても実行中のセッションには反映されません。反映するには Claude Code を再起動してください。
