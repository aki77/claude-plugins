#!/usr/bin/env node
import { resolveStatePath, readState } from "../../../hooks/handoff-shared.mjs";

const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
if (!sessionId) {
  console.log(JSON.stringify({ found: false, reason: "CLAUDE_CODE_SESSION_ID not set" }));
  process.exit(0);
}

const state = readState(resolveStatePath(sessionId, process.env));
console.log(JSON.stringify({ found: Boolean(state.lastInjected), lastInjected: state.lastInjected ?? null }));
