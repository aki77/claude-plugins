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

# cwdが無効な場合はスキップ
[[ -z "$CWD" ]] && exit 0

# gitリポジトリ確認（失敗時はスキップ）
git -C "$CWD" rev-parse --is-inside-work-tree > /dev/null 2>&1 || exit 0

# plan モード起点セッション限定: トランスクリプトに ExitPlanMode の tool_use が
# 存在しなければスキップ（transcript が空/不在なら plan 起点と判定できずスキップ）
[[ -z "$TRANSCRIPT" ]] && exit 0
[[ -f "$TRANSCRIPT" ]] || exit 0
# まず grep で ExitPlanMode を含む行に絞ってから jq で tool_use を厳密判定する
# （トランスクリプト全体を jq で舐めるのを避けつつ、文字列一致だけの誤検知も防ぐ）
if ! grep -F 'ExitPlanMode' "$TRANSCRIPT" | jq -es '
  any(.[]; .message.content[]? | select(.type == "tool_use") | .name == "ExitPlanMode")
' > /dev/null 2>&1; then
  exit 0
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
