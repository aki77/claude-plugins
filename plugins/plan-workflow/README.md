# plan-workflow

Plan モードの運用を支援する複合プラグインです。2つの独立したフックで構成されます。

1. **Plan モード運用ルール注入**（`UserPromptSubmit`）— Plan モード中の全プロンプトで、要件インタビュー・実装の Agent 委譲・モデル振り分けのルールをコンテキストに自動注入する（プランの視覚化ルールは [`plan-visualize`](../plan-visualize) プラグインに分離）
2. **プラン確認の mo プレビュー**（`PermissionRequest(ExitPlanMode)`）— 承認ダイアログ直前に、プランファイルを [`mo`](https://github.com/k1LoW/mo)（Markdown ビューア）でブラウザに開く

## 1. Plan モード運用ルール注入

Plan モードでは、要件インタビューを尽くさない・実装をメインセッションで直接行ってしまう・モデル振り分けが場当たり的になる、といった運用のブレが起きがちです。このプラグインは `UserPromptSubmit` フックで `permission_mode` を確認し、`"plan"` のときだけ運用ルールを `additionalContext` として注入します。**Plan モード以外（通常モード）では何も出力せず副作用ゼロ**です。

### しくみ

1. `UserPromptSubmit` イベントで、フックが stdin から `{ permission_mode, prompt, ... }` を受け取る（matcher なし、全プロンプトで発火）
2. `permission_mode !== "plan"` なら何も出力せず `exit 0`
3. `"plan"` のときは、運用ルールの文字列を組み立てて以下の形式で出力する:
   ```json
   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<ルール本文>" } }
   ```
4. 何が起きても最終的に `exit 0`

### 注入されるルール本文

```
# Plan モード運用ルール（このセッションで必ず適用する）
1. インタビュー: 初回プロンプトの後、要件の曖昧な点がなくなるまで AskUserQuestion で
   繰り返し質問する。1ラウンドで打ち切らず、回答から新たな曖昧点が生じたら追加で質問する。
2. 実行の委譲: ExitPlanMode 承認後、メインセッションではファイル編集・実装コマンドを
   直接実行しない。通常タスクは Agent ツール（model は 3. の基準で扱う）に移譲する。
   メインセッションの役割はタスク分割・指示・結果の検収・統合・報告のみ。
   例外: 会話全体の文脈を把握していないと実施できないタスク（plan 全体との整合が必要な
   統合・最終調整など）に限りメインセッションで実施してよい。それ以外の実装作業を
   メインセッションで行うことは不可。
3. モデル振り分け: 汎用エージェント（general-purpose 等）は model を明示し、基本は sonnet、
   設計判断・複雑なデバッグ・広範囲の変更など高難度タスクは opus を指定する。plan 策定の
   ための調査・設計サブエージェント（Explore / Plan）には opus を使う。カスタムエージェント
   は model を渡さず frontmatter の定義に任せる。上書きしてよいのは高難度タスクで opus に
   引き上げる場合のみで、sonnet への引き下げ上書きはしない。
```

> プランファイル作成時の視覚化ルール（Mermaid 図・表）の注入は [`plan-visualize`](../plan-visualize) プラグインに分離しました。視覚化ルールも使いたい場合はそちらを併せてインストールしてください。

## 2. プラン確認の mo プレビュー

**`PermissionRequest(ExitPlanMode)` フック**で、承認ダイアログが表示される直前に、そのセッションのプランファイル（`.claude/plans/*.md`）を [`mo`](https://github.com/k1LoW/mo)（Markdown ビューア）でブラウザに開くプラグインです。

Plan モードで作られるプランは長大な Markdown になりがちで、承認前にターミナルで読むのは負担が大きいです。実際に承認ダイアログが出るタイミングにだけ介入し、プランを GitHub-flavored Markdown（表・タスクリスト・Mermaid 図・シンタックスハイライト・ダーク/ライト対応）としてブラウザに表示します。**承認の可否判定には一切関与しません**（hook は JSON を返さず `exit 0` のみで終了します）。

### しくみ

1. `PermissionRequest` イベント（`matcher: "ExitPlanMode"`）で、フックが stdin から `{ transcript_path, session_id, ... }` を受け取る
   - このイベントは、実際に承認ダイアログが表示される直前にのみ発火する。他の hook（例: plan-rule-review）が先に `deny` してダイアログ自体が出ないケースでは発火しないため、無駄な処理が走らない
2. `transcript_path` の JSONL を先頭から走査し、`attachment.type === "plan_mode"` のレコードから `planFilePath`（プランファイルの絶対パス）を解決する。見つからなければ何もせずに終了する
3. planFilePath からプロジェクト名（`.claude/plans` の親ディレクトリ名）を導出し、`mo <planFilePath> --target <project>/plans --open` で開く
   - `--target` を `<project>/plans`（例: `social-apartment/plans`）にすることで、プロジェクトごとにグループ（`http://localhost:6275/<project>/plans`）が分かれ、複数プロジェクトを並行で見てもプランが混ざらない。プロジェクト名が導出できない場合は `plans` のみにフォールバックする
   - `mo` はバックグラウンドで起動しシェルを即座に返すため、フックがブロックする時間はごくわずか
   - `mo` は単一サーバー（既定 port 6275）で動作し、既に起動中なら既存セッションにファイルを追加する。そのため reject → 修正 → 再 ExitPlanMode で同じファイルを開き直してもタブが増殖しない（`mo` は CLI で開いたファイルの保存を監視して自動リロードもする）
   - `--open` を付けているのは重要。これが無いと、`mo` サーバーが既に起動している場合は「ファイルを既存グループに追加するだけでブラウザは前面に出さない」挙動になり、プランが追加されたことに気づけない。`--open` は「既存グループへの追加時でも必ずブラウザを開く」フラグで、毎回のプランがブラウザの最前面に表示される
4. 何が起きても最終的に `exit 0` で終了する。JSON（`decision`）を一切出力しないため、承認ダイアログの表示自体には影響しない

## インストール

```
/plugin marketplace add aki77/claude-plugins
/plugin install plan-workflow@plugin-hub
```

## 前提（mo プレビュー機能）

- [`mo`](https://github.com/k1LoW/mo) がインストール済みであること（`brew install k1LoW/tap/mo`）。`mo` が見つからない場合、フックは何もせず `exit 0` で終了します（承認フローには影響しません）。
- Node.js（Claude Code の動作要件に含まれるため追加インストール不要）。

## 環境変数

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `PLAN_WORKFLOW_TARGET` | `plans` | `mo` の `--target` に渡すグループ名の末尾セグメント。実際のグループ名は `<project>/<この値>`（プロジェクト名が導出できない場合はこの値のみ）。`http://localhost:6275/<project>/<この値>` に開かれる |
| `PLAN_WORKFLOW_DEBUG` | 未設定（ログ無効） | 真の値を設定するとステップログを出力する |
| `PLAN_WORKFLOW_DEBUG_FILE` | OS の temp ディレクトリ | デバッグログの出力先。既定は `<tmpdir>/plan-workflow-debug.log` |

## 元記事との差分

本プラグインの運用ルール注入は [Plan モードのループを改善する記事](https://zenn.dev/k_yoshiya/articles/claude-code-plan-mode-loop) の手法を踏まえていますが、以下の点で異なります。

- 実装の委譲は `claude --bg` / `claude -p` の別プロセス起動ではなく、Agent ツールへの一本化で行う
- plan 策定のための調査・設計サブエージェント（Explore / Plan）には opus を使う
- プラン確定シグナル（`<!-- render -->` マーカー）と HTML render 機構は採用しない。plan-workflow は既に `PermissionRequest(ExitPlanMode)` の mo プレビューでプラン確認を代替しているため不要

## トレードオフ・既知の制限（mo プレビュー機能）

- プランの表示は、transcript に `plan_mode` attachment（`planFilePath`）が記録されていることに依存します。プランがファイルとして保存されないケース（planFilePath が transcript に存在しないケース）では何も開かれません。
- `plan-rule-review` プラグインなど、他の ExitPlanMode 系フックと併用できます。互いに独立した hook として動作するため、`plan-rule-review` が違反を検出して `deny` した場合は承認ダイアログ自体が出ず、その場合はこのプラグインの `PermissionRequest` も発火しません。逆に `plan-rule-review` を通過してダイアログが出るケースでは、判定結果とは独立にこのプラグインが `mo` を起動します。
- 表示の見た目・機能（Mermaid・シンタックスハイライト・テーマなど）は `mo` に依存します。
- `hooks.json` はセッション起動時に読み込まれるため、プラグインをアップデートしても実行中のセッションには反映されません。反映するには Claude Code を再起動してください。
