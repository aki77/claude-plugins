#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSIONS_FILE = path.join(os.tmpdir(), "plan-rule-review-sessions.json");
const TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_REVIEWS = 2;
const PASSED_MARKER = "<!-- plan-rule-review: passed -->";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function getMaxReviews() {
  const raw = process.env.PLAN_RULE_REVIEW_MAX;
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

function buildReason() {
  return [
    "ExitPlanMode は plan-rule-review フックにより一旦ブロックされました。",
    "プランがプロジェクトルールに準拠しているかをレビューし、違反があれば修正してから再度 ExitPlanMode を呼んでください。",
    "",
    "レビュー手順:",
    "1. 以下のルールファイルを読み込む:",
    "   - ルート直下の CLAUDE.md、およびプランで変更予定のファイルを含むディレクトリ・その祖先ディレクトリの CLAUDE.md",
    "   - `.claude/rules/` 配下のルールファイルのうち、(a) `paths` frontmatter が未指定（全ファイル適用）のもの、",
    "     (b) `paths` の glob パターンがプランの変更対象ファイルのいずれかに一致するもの",
    "2. プラン内容がそれらルールに **違反していないか** のみをレビューする。",
    "   - バグ・一般的なコード品質・スタイルの懸念は対象外。プロジェクトルール違反のみを対象とする。",
    "   - 該当ルールを引用できる、明白かつ明確な違反のみを高シグナルな指摘として扱う。",
    "   - 確信が持てない指摘は行わない。",
    "3. 違反があればプランを具体的に修正する。指摘時は該当ルールの引用元（ファイルパス）を明示する。",
    "4. レビュー結果に応じて再度 ExitPlanMode を呼ぶ:",
    `   - 違反がなければ、プランの末尾に「${PASSED_MARKER}」を追記してから ExitPlanMode を呼ぶ。`,
    "     このマーカーがあると以降のレビューがスキップされ、即座に承認に進む。",
    "   - 違反があれば、プランを修正したうえで（マーカーは付けずに）ExitPlanMode を呼ぶ。",
    "   注意: マーカーはレビューを完了し違反がないことを確認した場合のみ付けること。",
    "   違反が残るプランにマーカーを付けてはならない。",
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

  // レビュー済み・違反なしのマーカーがあれば即許可（session I/O より前に判定）
  if (plan.includes(PASSED_MARKER)) process.exit(0);

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
        permissionDecisionReason: buildReason(),
      },
    })
  );
}

main().catch(() => process.exit(0));
