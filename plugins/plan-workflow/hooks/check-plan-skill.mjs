#!/usr/bin/env node
// ExitPlanMode のプラン本文に「実装は plan-implementation スキルに従う」旨の
// 記載があるかだけを検査する。プランの内容の是非はレビューしない。
// 記載があれば allow（追記されれば次回は通る設計。無限ループを避けるため
// 記載の有無のみで判定する）。

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

const REASON =
  "プラン本文に「実装は plan-implementation スキルに従う」の一文を追記して、再度 ExitPlanMode を呼んでください";

// markdown 装飾（**bold**・`code`）と空白の揺れを吸収してから照合する。
// 実データでは「実装は **plan-implementation スキルに従う**。」
// 「実装は `plan-implementation` スキルに従う。」等の表記揺れが多数ある。
export function hasSkillReference(plan) {
  const normalized = plan.replace(/[*`\s]+/g, "");
  return normalized.includes("実装はplan-implementationスキルに従う");
}

async function main() {
  const raw = await readStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const plan = payload?.tool_input?.plan;
  // plan が取れないときは判定不能。フックは Claude の動作を妨げない。
  if (!plan || typeof plan !== "string") process.exit(0);

  if (hasSkillReference(plan)) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: REASON,
      },
    })
  );
}

if (!process.env.NODE_TEST_CONTEXT) {
  main().catch(() => process.exit(0));
} else {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  test("hasSkillReference: 実データに現れた表記揺れをすべて許容する", () => {
    // 全セッションの transcript から採取した実際の記載パターン
    const variants = [
      "実装は plan-implementation スキルに従う。",
      "実装は **plan-implementation スキルに従う**。",
      "実装は **plan-implementation スキルに従う**（実行の委譲・実装エージェントのモデル振り分け）",
      "実装は **plan-implementation スキル**に従う（実行の委譲）",
      "実装は **plan-implementation スキル**に従う。",
      "実装は plan-implementation スキルに従う（実行の委譲）",
      "実装は `plan-implementation` スキルに従う。",
      "実装は plan-implementation スキルに従う。**",
      "実装は plan-implementation スキルに従う",
      "実装は **plan-implementation スキル** に従う。",
    ];
    for (const v of variants) {
      assert.equal(hasSkillReference(`# プラン\n\n## 実装について\n\n${v}\n`), true, v);
    }
  });

  test("hasSkillReference: 記載がなければ false", () => {
    assert.equal(hasSkillReference("# プラン\n\n調査するだけの計画。"), false);
    assert.equal(hasSkillReference(""), false);
    // 別スキル名を誤検出しない
    assert.equal(hasSkillReference("実装は plan-visualize スキルに従う。"), false);
  });

  test("hasSkillReference: 長文プランの末尾にあっても検出する", () => {
    const plan = `${"あ".repeat(13000)}\n\n実装は plan-implementation スキルに従う。`;
    assert.equal(hasSkillReference(plan), true);
  });
}
