---
description: auto-simplify-hook の Stop hook をプロジェクト単位・セッション単位で一時的に有効/無効切替え
argument-hint: "[project|session] [on|off|status]"
allowed-tools: Bash(jq:*), Bash(mkdir:*), Bash(date:*), Bash(cat:*)
disable-model-invocation: true
---

`auto-simplify-hook` プラグインの Stop hook（git diff 10行以上の変更で `/simplify` を促すチェック）を、プロジェクト単位またはセッション単位で有効/無効切替えする。

## 引数

- `$1`: スコープ。`project`（現在のリポジトリ全体）または `session`（現在のセッションのみ）
- `$2`: 操作。`on`（有効化）、`off`（無効化）、`status`（状態表示のみ）

## 状態の保存先

保存先ディレクトリ: `${CLAUDE_PLUGIN_DATA}`（このコマンド本文内で解決済みの値をそのまま使う。Bashで `$CLAUDE_PLUGIN_DATA` を改めて読み直さない — 別プロセスになりスコープが異なるため未設定に見えることがある）

以下、このディレクトリを「保存先ディレクトリ」と呼ぶ。

- 保存先ディレクトリ/projects.json — `{ "<cwd>": { "enabled": false } }` 形式。キー不在時はデフォルト有効
- 保存先ディレクトリ/sessions.json — `{ "<session_id>": { "disabled": true, "ts": <epoch_ms> } }` 形式。TTL 24時間

## 実行手順

1. `$1` と `$2` を検証する。`$1` が `project`/`session` のいずれでもない、または `$2` が `on`/`off`/`status` のいずれでもない、あるいはどちらか一方でも省略されている場合は、**絶対にファイルを書き換えず**、手順4の状態表示のみを行って終了する。
2. 保存先ディレクトリが未解決の場合は、状態を保存できない旨を伝えて終了する（フォールバックとして hook は常時有効のまま動作する）。
3. 検証を通過した場合のみ、以下の副作用を実行する:
   - `mkdir -p` で保存先ディレクトリを用意する
   - `project off`: 保存先ディレクトリ/projects.json を読み込み、現在の cwd（`pwd` の絶対パス）をキーに `{"enabled": false}` をセットして書き戻す（jqで既存内容とマージ、ファイルが無ければ `{}` から開始）
   - `project on`: 保存先ディレクトリ/projects.json から現在の cwd キーを削除する（jqの `del(.[$cwd])`）
   - `session off`: 保存先ディレクトリ/sessions.json を読み込み、現在のセッションID（transcriptやセッションコンテキストから判別できるIDを使用）をキーに `{"disabled": true, "ts": <現在時刻のミリ秒epoch>}` をセットする。ミリ秒epochは `date +%s` の値を1000倍して求める
   - `session on`: 保存先ディレクトリ/sessions.json から現在のセッションIDキーを削除する
   - JSON書き込みは一時ファイルに出力してから `mv` で置き換え、壊れた書き込みを防ぐ
4. 最後に必ず現在の状態を表示する:
   - 保存先ディレクトリ/projects.json に現在の cwd のエントリがあるか（無効化中かどうか）。jqでの判定は `(.[$cwd].enabled == false)` のように明示比較する（`// true` のようなフォールバック演算子は使わない — `false` もfalsyとして右辺に落ちてしまい `enabled: false` を正しく判定できないため）
   - 保存先ディレクトリ/sessions.json に現在のセッションIDのエントリがあり、かつTTL(24時間)以内かどうか。同様に `(.[$sid].disabled == true)` のように明示比較する
   - ファイルが存在しない、またはエントリが無い場合は「有効（デフォルト）」と表示する

引数が不正な場合の出力例:
```
使い方: /toggle [project|session] [on|off|status]
現在の状態:
  project (このリポジトリ): 有効
  session (このセッション): 有効
```
