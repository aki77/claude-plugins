#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)

# stop_hook_active が true の場合はスキップ（再帰ループ防止）
STOP_HOOK_ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

# 必要なフィールドを取得
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""')
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // "."')
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""')

# セッション単位の無効化チェック（/toggle session off、TTL 24時間）
SESSIONS_FILE="${CLAUDE_PLUGIN_DATA:-}/sessions.json"
if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]] && [[ -n "$SESSION_ID" ]] && [[ -f "$SESSIONS_FILE" ]]; then
  NOW_MS=$(($(date +%s) * 1000))
  SESSION_DISABLED=$(jq -r --arg sid "$SESSION_ID" --argjson now "$NOW_MS" '
    (.[$sid] // {}) as $entry
    | if ($entry.disabled == true) and (($now - ($entry.ts // 0)) < 86400000)
      then "true" else "false" end
  ' "$SESSIONS_FILE" 2>/dev/null || echo "false")
  if [[ "$SESSION_DISABLED" == "true" ]]; then
    exit 0
  fi
fi

# cwdが無効な場合はスキップ
[[ -z "$CWD" ]] && exit 0

# プロジェクト単位の無効化チェック（/toggle project off）
PROJECTS_FILE="${CLAUDE_PLUGIN_DATA:-}/projects.json"
if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]] && [[ -f "$PROJECTS_FILE" ]]; then
  PROJECT_DISABLED=$(jq -r --arg cwd "$CWD" '(.[$cwd].enabled == false)' "$PROJECTS_FILE" 2>/dev/null || echo "false")
  if [[ "$PROJECT_DISABLED" == "true" ]]; then
    exit 0
  fi
fi

# gitリポジトリ確認（失敗時はスキップ）
git -C "$CWD" rev-parse --is-inside-work-tree > /dev/null 2>&1 || exit 0

# 同一セッション内でファイル編集ツールが呼ばれたかを確認（呼ばれていなければスキップ）
if [[ -n "$TRANSCRIPT" ]] && [[ -f "$TRANSCRIPT" ]]; then
  EDITED=$(jq -rs '
    any(.[];
      ( .message.content[]? | select(.type == "tool_use")
        | (.name == "Edit" or .name == "Write" or .name == "MultiEdit" or .name == "NotebookEdit") )
      // ( (.toolUseResult.toolStats.editFileCount // 0) > 0 )
    )
  ' "$TRANSCRIPT" 2>/dev/null || echo "false")
  if [[ "$EDITED" != "true" ]]; then
    exit 0
  fi
fi

# /simplify はコード簡素化が目的のため、ドキュメント・設定・ロック・データ/画像は集計から除外
EXCLUDES=(
  ':(exclude)*.md' ':(exclude)*.mdx' ':(exclude)*.txt' ':(exclude)*.rst' ':(exclude)*.adoc'
  ':(exclude)*.yml' ':(exclude)*.yaml' ':(exclude)*.json' ':(exclude)*.toml' ':(exclude)*.ini'
  ':(exclude)*.lock' ':(exclude)*.lockb' ':(exclude)*-lock.json' ':(exclude)*-lock.yaml'
  ':(exclude)*.csv' ':(exclude)*.tsv'
  ':(exclude)*.svg' ':(exclude)*.png' ':(exclude)*.jpg' ':(exclude)*.jpeg'
  ':(exclude)*.gif' ':(exclude)*.webp' ':(exclude)*.ico' ':(exclude)*.snap'
)
# git diff --numstat の追加・削除行数の合計を計算
DIFF_OUTPUT=$(git -C "$CWD" diff --numstat -- . "${EXCLUDES[@]}" 2>/dev/null || true)

if [[ -z "$DIFF_OUTPUT" ]]; then
  exit 0
fi

TOTAL_LINES=$(printf '%s' "$DIFF_OUTPUT" | awk '/^[0-9]/ { added += $1; deleted += $2 } END { print added + deleted }')

# 変更が10行未満の場合はスキップ
if [[ -z "$TOTAL_LINES" ]] || (( TOTAL_LINES < 10 )); then
  exit 0
fi

# transcriptに /simplify が含まれているかチェック
if [[ -n "$TRANSCRIPT" ]] && [[ -f "$TRANSCRIPT" ]] && grep -q '/simplify' "$TRANSCRIPT"; then
  exit 0
fi

# blockレスポンスを返す
jq -n --argjson lines "$TOTAL_LINES" '{
  decision: "block",
  reason: ("/simplify コマンドを実行してください（" + ($lines | tostring) + "行以上の変更があります）")
}'
