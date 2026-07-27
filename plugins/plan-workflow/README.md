# plan-workflow

Plan モードの運用ルール（要件インタビュー・策定サブエージェントのモデル振り分け）を、`UserPromptSubmit` フックでコンテキストに自動注入するプラグインです。あわせて `ExitPlanMode` の `PreToolUse` command フックで、プランに実装フェーズ用スキル（`plan-implementation`）の記載があるかを判定し、記載を促します。実装後の `/simplify` 実行と、それに続く任意のレビューコマンド実行は、`plan-implementation` スキルの手順に含まれます。

Plan モードでは、要件インタビューを尽くさない・実装をメインセッションで直接行ってしまう・モデル振り分けが場当たり的になる、といった運用のブレが起きがちです。このプラグインは `UserPromptSubmit` フックで `permission_mode` を確認し、`"plan"` のときだけ plan 策定用の運用ルールを `additionalContext` として注入します。**Plan モード以外（通常モード）では何も出力せず副作用ゼロ**です。

**実装フェーズの運用ルール（実行の委譲・実装エージェントのモデル振り分け・実装後の `/simplify` 実行・コミット禁止）は [`plan-implementation`](skills/plan-implementation/SKILL.md) スキルに分離しています。** `UserPromptSubmit` はプラン策定中にのみ関わるため、承認後の実装フェーズでしか効かないルールをここに含めるとコンテキストを圧迫します。スキルは自動ロードが保証されないため、`inject-rules.sh` はプラン本文に「実装は `plan-implementation` スキルに従う」旨を明記するよう促し、さらに `ExitPlanMode` の `PreToolUse` command フックが記載の有無を検問します（詳細は後述）。

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

## PreToolUse(ExitPlanMode) command フック

`ExitPlanMode` が呼ばれるたびに、`PreToolUse` の command フック（`hooks/check-plan-skill.mjs`）がプラン本文（`tool_input.plan`）を検査し、次を判定します。

- プラン本文に「実装は `plan-implementation` スキルに従う」旨の記載があれば allow。
- 記載がなければ deny し、reason で「記載を追記して再度 ExitPlanMode を呼べ」と促す。

マーカー行（`<!-- -->` 等）という人工物はプランに残さず、「実装は `plan-implementation` スキルに従う」という自然文だけで通ります。照合前に markdown 装飾（`**bold**`・`` `code` ``）と空白を除去して正規化するため、`実装は **plan-implementation スキルに従う**。` や `` 実装は `plan-implementation` スキルに従う。 `` のような表記揺れも許容します。

判定は「一文の有無」だけなので、実装の有無を問わずすべてのプランに記載を求めます。調査のみの計画にも一文が必要になりますが、機械的判定に倒すことで後述の誤判定リスクを避けています。

**以前は prompt フック（LLM 判定）でしたが、command フックに変更しました。** prompt フックはプラン本文を `$TOOL_INPUT` でプロンプトに展開する方式のため、1万字級のプランでは記載が判定モデルに届かず、**一文が実在するのに deny され続けて先に進めなくなる**事象が発生しました（実測: 13,000 字のプランで3回連続 deny）。判定内容が文字列の有無だけである以上、LLM 判定は不要であり、command フックのほうが速く・確実です。副次的に、`node --test` によるインラインテストで表記揺れの回帰を検証できるようになりました（`NODE_TEST_CONTEXT=1 node hooks/check-plan-skill.mjs`）。

## 実装後の `/simplify`

実装フェーズ完了後の `/simplify` 実行は [`plan-implementation`](skills/plan-implementation/SKILL.md) スキルの手順に含まれます。以前は `Stop` フックで機械的に促していましたが、`/simplify` の後段に別処理（レビュー等）を差し込む拡張を見据え、状態を持てず順序制御が難しいフック方式から、一連の流れを表現できるスキル手順方式へ移しました。

環境変数 `PLAN_REVIEW_SKILL` にレビュースキル名（例 `/code-review`。引数付きや自然文の指示も可）を設定すると、その値が `/simplify` 完了後に実行されます。未設定・空ならスキップされます。実行対象はスキル呼び出し（スラッシュコマンド）であってシェルコマンドではありません。値の取得には Claude Code スキルの動的コンテキスト注入（`` !`command` `` 構文）を使い、スキルロード時に一度だけ同梱スクリプト `skills/plan-implementation/scripts/print-review-skill.sh` を実行して確定値を本文に注入します。Claude が Bash で環境変数を読み直すのではなく確定済みの値を受け取るため、挙動が安定します。

動的注入コマンドには 2 つの制約があり、それを避けるためにラッパースクリプトを介しています。(1) `echo "${PLAN_REVIEW_SKILL:-}"` のように `${...}` 展開を含むコマンドは許可チェックが「Contains expansion」として拒否する。(2) `printenv PLAN_REVIEW_SKILL` は未設定時に終了コード 1 を返し、動的注入がそれを「Shell command failed」と扱ってスキル読込ごと失敗させる。スクリプト内で `printf '%s' "${PLAN_REVIEW_SKILL:-}"` を実行し常に終了コード 0 で終わることで両方を回避し、SKILL.md の frontmatter で `allowed-tools: Bash(sh:*)` を許可しています。

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
