#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  buildAdditionalContext,
  createLogger,
  readState,
  readStdin,
  resolveStatePath,
  writeState,
} from "./handoff-shared.mjs";

async function main() {
  const log = createLogger(process.env);

  log(`=== SessionStart(compact) hook started: ${new Date().toISOString()} ===`);

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log("[1] failed to parse JSON input");
    process.exit(0);
  }

  const sessionId = payload?.session_id;
  log(`[2] session_id=${sessionId}`);
  if (!sessionId) {
    log("[2] session_id missing");
    process.exit(0);
  }

  const statePath = resolveStatePath(sessionId, process.env);
  const state = readState(statePath);
  const pending = state.pending;
  log(`[3] statePath=${statePath} pending.status=${pending?.status ?? "none"}`);

  if (!pending) {
    log("[3] no pending handoff, nothing to inject");
    process.exit(0);
  }

  // 二重注入を防ぐため、内容を使う前に消費済み(pending: null)として保存する。
  // lastProcessedLineCount は PreCompact 側の位置ブックマークなのでそのまま温存する。
  // 消費した内容は lastInjected に退避し、後から compact-handoff-status スキルで確認できるようにする。
  writeState(statePath, { ...state, pending: null, lastInjected: pending });

  if (pending.status === "error") {
    log("[4] pending status=error");
    console.log(
      JSON.stringify({
        systemMessage: "[compact-handoff] 圧縮の隙間情報の抽出に失敗しました（詳細はデバッグログ参照）",
      })
    );
    process.exit(0);
  }

  if (pending.status === "no_gap") {
    log("[4] pending status=no_gap");
    console.log(
      JSON.stringify({ systemMessage: "[compact-handoff] 今回は注入すべき情報はありませんでした" })
    );
    process.exit(0);
  }

  const additionalContext = buildAdditionalContext(pending.content);
  log(`[4] injected additionalContext: ${additionalContext.length} chars`);
  log(`=== SessionStart(compact) hook finished: ${new Date().toISOString()} ===`);
  console.log(
    JSON.stringify({
      systemMessage: `[compact-handoff] 圧縮の隙間情報を注入しました:\n\n${pending.content}`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
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
  // このファイルは main() の統合フローのみを持ち、整形ロジック(buildAdditionalContext等)は
  // handoff-shared.mjs 側でテスト済み（既存コードの慣習を踏襲）。
}
