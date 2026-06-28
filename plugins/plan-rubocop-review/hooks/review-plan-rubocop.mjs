#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSIONS_FILE = path.join(
  os.tmpdir(),
  "plan-rubocop-review-sessions.json"
);
const TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_REVIEWS = 2;
const PASSED_MARKER = "<!-- plan-rubocop-review: passed -->";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

// プラン本文に ```ruby / ```rb の開始フェンスが 1 つ以上あるかを軽量に判定する。
// 厳密な Markdown パースはしない（フックは軽量・高速に保つ。正確な抽出は SKILL 側で行う）。
function hasRubyCodeBlock(plan) {
  return /^[ \t]*(`{3,}|~{3,})[ \t]*(ruby|rb)\b/im.test(plan);
}

function getMaxReviews() {
  const raw = process.env.PLAN_RUBOCOP_REVIEW_MAX;
  if (!raw) return DEFAULT_MAX_REVIEWS;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_REVIEWS;
}

function loadSessions(now) {
  let data = {};
  if (existsSync(SESSIONS_FILE)) {
    try {
      data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8")) || {};
    } catch {
      data = {};
    }
  }
  // 24h より古いエントリを除去
  for (const [id, entry] of Object.entries(data)) {
    if (!entry || typeof entry.ts !== "number" || now - entry.ts > TTL_MS) {
      delete data[id];
    }
  }
  return data;
}

function saveSessions(data) {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(data));
  } catch {
    // 書き込み失敗は無視（フックは Claude の動作を妨げない）
  }
}

function buildReason(plan) {
  return [
    "ExitPlanMode は plan-rubocop-review フックにより一旦ブロックされました。",
    "プラン内 Ruby コードブロックの RuboCop 検証は plan-rubocop-review プラグインの `plan-rubocop-review-run` スキルで行います。",
    "",
    "次の Skill を実行してください: `plan-rubocop-review:plan-rubocop-review-run`",
    "スキルの手順（Ruby コードブロックと配置パスの抽出 → `rubocop --stdin <path>` で検証 → 違反があればプラン内コードを修正して再 ExitPlanMode）に従ってください。",
    "検証手順の詳細・厳守事項はスキル本文に記載されています。",
    "",
    "検証対象のプラン全文:",
    "<<<PLAN",
    plan,
    "PLAN",
  ].join("\n");
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
  if (!plan || typeof plan !== "string") process.exit(0);

  // 検証済み・違反なしのマーカーがあれば即許可（session I/O より前に判定）
  if (plan.includes(PASSED_MARKER)) process.exit(0);

  // ```ruby ブロックを含まないプランは検証対象外。deny もカウントもせず即素通し。
  if (!hasRubyCodeBlock(plan)) process.exit(0);

  const sessionId = payload?.session_id;
  if (!sessionId || typeof sessionId !== "string") process.exit(0);

  const maxReviews = getMaxReviews();
  const now = Date.now();
  const sessions = loadSessions(now);
  const count = sessions[sessionId]?.count ?? 0;

  if (count >= maxReviews) {
    // 上限到達: ExitPlanMode を許可（無限ループ防止）
    saveSessions(sessions);
    process.exit(0);
  }

  sessions[sessionId] = { count: count + 1, ts: now };
  saveSessions(sessions);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: buildReason(plan),
      },
    })
  );
}

main().catch(() => process.exit(0));
