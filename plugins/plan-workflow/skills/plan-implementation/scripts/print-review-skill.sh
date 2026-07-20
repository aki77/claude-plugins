#!/bin/sh
# PLAN_REVIEW_SKILL の値を出力する。未設定なら空を出力し、常に exit 0 で終わる。
# plan-implementation スキル本文の動的コンテキスト注入 !`command` から呼ばれる。
# printenv は未設定時に exit 1 を返し、動的注入がそれを「Shell command failed」と
# 扱ってスキル読込ごと失敗させるため、このラッパーで終了コードを 0 に固定する。
printf '%s' "${PLAN_REVIEW_SKILL:-}"
