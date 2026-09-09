---
name: usage-guard-status
description: usage-guard の現在の状態（mode、5時間枠・週次枠の消費率と閾値、バイパス状況、判定）を表示する。
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

次のコマンドを実行し、出力をそのまま提示する（要約・整形はしない。生のテキストを見せることが目的）。

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node ${CLAUDE_PLUGIN_ROOT}/skills/usage-guard-status/scripts/status.mjs
```
