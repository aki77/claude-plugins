#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[[ -z "$FILE_PATH" ]] && exit 0

# 既に何かが存在する場合は素通し（通常ファイル・シンボリックリンク等）
[[ -e "$FILE_PATH" ]] && exit 0

# 新規作成 → 空ファイルを作成して Write を deny。Claude は理由を読んで Read を実行し、
# その時点でパスベースのルールが context に注入される。続く Write/Edit でルールが効く。
mkdir -p "$(dirname "$FILE_PATH")"
touch "$FILE_PATH"

REASON="File '${FILE_PATH}' did not exist. It was created empty. Path-based rules may apply but are only loaded on Read. You MUST Read this file first (to load rules), then Write/Edit with the discovered rules."

jq -n --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
