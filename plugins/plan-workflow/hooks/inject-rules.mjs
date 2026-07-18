#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readStdin } from "./preview-shared.mjs";

// Plan モード運用ルール（インタビュー / 実行の委譲 / モデル振り分け）と、
// プランファイル作成時の視覚化ルール（マーメイド図・表）を1本の文字列にまとめる。
// UserPromptSubmit の additionalContext に注入する本文はこの関数が唯一の情報源。
export function buildPlanModeContext() {
  return `# Plan モード運用ルール（このセッションで必ず適用する）
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

# プランファイル作成時の視覚化ルール
- 手順・フロー・構成・スケジュールなど、順序や関係が本質の内容はマーメイド図で視覚化する。
- 比較・列挙は表にする。`;
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  if (payload?.permission_mode !== "plan") {
    process.exit(0);
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildPlanModeContext(),
      },
    })
  );
  process.exit(0);
}

if (!process.env.NODE_TEST_CONTEXT) {
  main().catch(() => process.exit(0));
}

// ---- インラインテスト --------------------------------------------------------
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  test("buildPlanModeContext: 運用ルールと視覚化ルールの両セクションを含む文字列を返す", () => {
    const context = buildPlanModeContext();
    assert.ok(context.includes("# Plan モード運用ルール"));
    assert.ok(context.includes("# プランファイル作成時の視覚化ルール"));
    assert.ok(context.includes("AskUserQuestion"));
    assert.ok(context.includes("マーメイド図"));
  });
}
