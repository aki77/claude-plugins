#!/bin/sh
# plan モード時に UserPromptSubmit で Plan モード運用ルール
# （要件インタビュー・実装の Agent 委譲・モデル振り分け）を additionalContext として
# 注入する。plan モード以外は何も出力せず exit 0。
# 視覚化ルールは plan-visualize プラグインに分離済み。
set -eu

payload=$(cat)
mode=$(printf '%s' "$payload" | jq -r '.permission_mode // empty' 2>/dev/null || true)
[ "$mode" = "plan" ] || exit 0

context=$(cat <<'EOF'
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
EOF
)

jq -n --arg ctx "$context" \
  '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}'
