---
name: compact-handoff-status
description: このセッションで直近の /compact により compact-handoff が注入した HANDOFF GAPS の内容を表示する。
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

次のコマンドを実行し、結果のJSONに応じて表示する。

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/compact-handoff-status/scripts/show-last-injected.mjs
```

- `found: false` の場合: 「このセッションではまだ compact-handoff による注入は行われていません」と伝えて終了する
- `found: true` の場合、`lastInjected.status` に応じて:
  - `"content"` → `lastInjected.content` をそのまま表示する（要約・整形はしない。注入された生の内容を見せることが目的）
  - `"no_gap"` → 「直近の compact では注入すべき情報はありませんでした」と伝える
  - `"error"` → 「直近の compact では抽出に失敗しました」と伝える
