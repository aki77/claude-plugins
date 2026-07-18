# plan-preview

**`PermissionRequest(ExitPlanMode)` フック**で、承認ダイアログが表示される直前に、そのセッションのプランファイル（`.claude/plans/*.md`）を [`mo`](https://github.com/k1LoW/mo)（Markdown ビューア）でブラウザに開くプラグインです。

Plan モードで作られるプランは長大な Markdown になりがちで、承認前にターミナルで読むのは負担が大きいです。このプラグインは、実際に承認ダイアログが出るタイミングにだけ介入し、プランを GitHub-flavored Markdown（表・タスクリスト・Mermaid 図・シンタックスハイライト・ダーク/ライト対応）としてブラウザに表示します。**承認の可否判定には一切関与しません**（hook は JSON を返さず `exit 0` のみで終了します）。

## しくみ

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
/plugin install plan-preview@plugin-hub
```

## 前提

- [`mo`](https://github.com/k1LoW/mo) がインストール済みであること（`brew install k1LoW/tap/mo`）。`mo` が見つからない場合、フックは何もせず `exit 0` で終了します（承認フローには影響しません）。
- Node.js（Claude Code の動作要件に含まれるため追加インストール不要）。

## 環境変数

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `PLAN_PREVIEW_TARGET` | `plans` | `mo` の `--target` に渡すグループ名の末尾セグメント。実際のグループ名は `<project>/<この値>`（プロジェクト名が導出できない場合はこの値のみ）。`http://localhost:6275/<project>/<この値>` に開かれる |
| `PLAN_PREVIEW_DEBUG` | 未設定（ログ無効） | 真の値を設定するとステップログを出力する |
| `PLAN_PREVIEW_DEBUG_FILE` | OS の temp ディレクトリ | デバッグログの出力先。既定は `<tmpdir>/plan-preview-debug.log` |

## トレードオフ・既知の制限

- プランの表示は、transcript に `plan_mode` attachment（`planFilePath`）が記録されていることに依存します。プランがファイルとして保存されないケース（planFilePath が transcript に存在しないケース）では何も開かれません。
- `plan-rule-review` プラグインなど、他の ExitPlanMode 系フックと併用できます。互いに独立した hook として動作するため、`plan-rule-review` が違反を検出して `deny` した場合は承認ダイアログ自体が出ず、その場合はこのプラグインの `PermissionRequest` も発火しません。逆に `plan-rule-review` を通過してダイアログが出るケースでは、判定結果とは独立にこのプラグインが `mo` を起動します。
- 表示の見た目・機能（Mermaid・シンタックスハイライト・テーマなど）は `mo` に依存します。
- `hooks.json` はセッション起動時に読み込まれるため、プラグインをアップデートしても実行中のセッションには反映されません。反映するには Claude Code を再起動してください。
