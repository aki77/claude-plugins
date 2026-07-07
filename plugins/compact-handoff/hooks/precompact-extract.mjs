#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractNewSegment, parseTranscriptLines } from "./transcript-segment.mjs";
import {
  buildGapPrompt,
  createLogger,
  isValidOutput,
  readState,
  readStdin,
  resolveDebugLogPath,
  resolveModel,
  resolveStatePath,
  sanitizeOutput,
  truncateSegment,
  writeState,
} from "./handoff-shared.mjs";

// hooks.json の timeout(600s) より少し下げ、kill される前にログ・exit できる余地を残す
const CLAUDE_TIMEOUT_MS = 580_000;

async function main() {
  const log = createLogger(process.env);

  log(`=== PreCompact hook started: ${new Date().toISOString()} ===`);

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log("[1] failed to parse JSON input");
    process.exit(0);
  }

  const transcriptPath = payload?.transcript_path;
  const sessionId = payload?.session_id;
  log(`[2] transcript_path=${transcriptPath} session_id=${sessionId} trigger=${payload?.trigger ?? "unknown"}`);
  if (!transcriptPath || !sessionId) {
    log("[2] transcript_path or session_id missing");
    process.exit(0);
  }

  const statePath = resolveStatePath(sessionId, process.env);
  const state = readState(statePath);
  const lastProcessedLineCount = state.lastProcessedLineCount ?? 0;
  log(`[3] statePath=${statePath} lastProcessedLineCount=${lastProcessedLineCount}`);

  let transcriptText;
  try {
    transcriptText = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    log(`[3] failed to read transcript: ${transcriptPath}`);
    process.exit(0);
  }

  const segment = extractNewSegment(parseTranscriptLines(transcriptText), lastProcessedLineCount);
  log(`[4] segment: totalLineCount=${segment.totalLineCount} chars=${segment.segmentText.length}`);

  if (segment.isEmpty) {
    log("[4] segment is empty, nothing to summarize");
    writeState(statePath, { ...state, lastProcessedLineCount: segment.totalLineCount });
    process.exit(0);
  }

  const segmentText = truncateSegment(segment.segmentText);
  const model = resolveModel(process.env);
  log(`[5] calling claude -p... model=${model}`);
  const prompt = buildGapPrompt(segmentText);
  let claudeOutput = "";
  let exitCode = 0;
  try {
    claudeOutput = execFileSync(
      "claude",
      ["-p", "--model", model, "--setting-sources", "", "--strict-mcp-config"],
      {
        input: prompt,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: CLAUDE_TIMEOUT_MS,
      }
    );
  } catch (err) {
    exitCode = err.status ?? 1;
    claudeOutput = err.stdout?.toString() ?? "";
    if (err.stderr) log(`[5] stderr: ${err.stderr.toString()}`);
  }

  const cleaned = sanitizeOutput(claudeOutput);
  log(`[6] exit=${exitCode} output=${cleaned.length} chars`);

  const pending = !isValidOutput(cleaned, exitCode)
    ? { status: "error", createdAt: new Date().toISOString() }
    : cleaned.trim() === "(NO_GAP_CONTENT)"
      ? { status: "no_gap", createdAt: new Date().toISOString() }
      : { status: "content", content: cleaned, createdAt: new Date().toISOString() };

  log(`[7] pending.status=${pending.status}`);
  writeState(statePath, { ...state, lastProcessedLineCount: segment.totalLineCount, pending });
  log(`=== PreCompact hook finished: ${new Date().toISOString()} ===`);
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
  // このファイルは main() の統合フローのみを持ち、抽出・判定・整形の純粋ロジックは
  // transcript-segment.mjs / handoff-shared.mjs 側でテスト済み（既存コードの慣習を踏襲）。
}
