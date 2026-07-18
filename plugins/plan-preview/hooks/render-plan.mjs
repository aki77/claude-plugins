#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createLogger,
  readStdin,
  resolvePlanFilePath,
  resolveTarget,
} from "./preview-shared.mjs";

async function main() {
  const log = createLogger(process.env);

  log(`=== PermissionRequest(ExitPlanMode) hook started: ${new Date().toISOString()} ===`);

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log("[1] failed to parse JSON input");
    process.exit(0);
  }

  const transcriptPath = payload?.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== "string") {
    log("[2] transcript_path missing");
    process.exit(0);
  }

  let transcriptText;
  try {
    transcriptText = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    log(`[2] failed to read transcript: ${transcriptPath}`);
    process.exit(0);
  }

  const planFilePath = resolvePlanFilePath(transcriptText);
  if (!planFilePath) {
    log("[3] planFilePath not found in transcript");
    process.exit(0);
  }
  log(`[3] planFilePath=${planFilePath}`);

  const target = resolveTarget(planFilePath, process.env);
  log(`[4] opening with mo... target=${target}`);
  try {
    // mo はバックグラウンドで起動しシェルを即座に返す（LLM ワークフロー向けの挙動）。
    // 同一ポートに既存サーバがあれば既存セッションにファイルを追加するため、
    // 再 ExitPlanMode で同じファイルを開き直しても増殖しない。
    // --open は「既存グループへの追加時でも必ずブラウザを開く」フラグ。これが無いと
    // mo は既存サーバにファイルを追加するだけでブラウザを前面に出さず、追加に気づけない。
    execFileSync("mo", [planFilePath, "--target", target, "--open"], { stdio: "ignore" });
    log(`[5] opened ${planFilePath}`);
  } catch (err) {
    log(`[5] failed to run mo: ${err?.message}`);
  }

  log(`=== PermissionRequest(ExitPlanMode) hook finished: ${new Date().toISOString()} ===`);
  // JSON を出さず exit 0 のみ返す。承認判定には一切干渉しない。
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
  // このファイルは main() の統合フローのみを持ち、planFilePath 解決・target 決定などの
  // 純粋ロジックは preview-shared.mjs 側でテスト済み（compact-handoff の慣習を踏襲）。
}
