#!/usr/bin/env node
// usage-guard のトークン更新フック。SessionStart で async: true として走る。
//
// 役割はキャッシュ更新だけで、判定（allow/warn/block）は一切しない。
// 非同期フックの出力（additionalContext / systemMessage）はユーザーに表示されないため、
// このフックは何も出力せずに終える。ユーザーへの通知は guard.mjs 側の責務。
//
// 認証情報は絶対に書き込まない（読み取り専用）。
// アクセストークンのローテーションと Keychain / .credentials.json への書き込みは
// Claude Code CLI 自身が所有している。ここでやることは「CLI に更新させる」だけで、
// トークンを自前で取得・保存しようとしてはいけない（CLI 側の状態と食い違って認証が壊れる）。
import { execFileSync } from "node:child_process";

import {
  createLogger,
  isTokenExpired,
  loadConfig,
  readJson,
  readStdin,
  resolveRefreshCooldownPath,
  shouldAttemptRefresh,
  writeJsonAtomic,
} from "./guard-shared.mjs";
// 取得処理は guard.mjs のものを再利用する（重複実装しない）。
import { fetchUsageIfStale, readCredentials } from "./guard.mjs";

// `claude -p` のタイムアウト。トークン更新を含む往復なので長めに取る。
// このフックは async: true で走る。async な command フックには hooks.json の
// timeout が適用されない（Claude Code は背景に入ったフックに timeout を強制しない）ため、
// 各 execFileSync に渡す内部タイムアウトが唯一の歯止めになる。
// ここに timeout なしの待ち処理を足すと、ハングしたプロセスを止める手段が無くなる。
const REFRESH_TIMEOUT_MS = 60_000;
// 更新のトリガに使う軽量モデル。実質「トークンを使わせる」だけが目的なので最小構成で叩く。
const REFRESH_MODEL = "claude-haiku-4-5-20251001";

async function main() {
  const log = createLogger(process.env);
  log(`=== usage-guard refresh hook started: ${new Date().toISOString()} ===`);

  // stdin は読み捨てる（内容は使わないが、読まないと書き手側でパイプが詰まりうる）。
  await readStdin();

  const config = loadConfig(process.env);
  if (config.mode === "off" || config.auto_refresh === false) {
    log(`[1] disabled (mode=${config.mode} auto_refresh=${config.auto_refresh})`);
    process.exit(0);
  }
  log(`[1] mode=${config.mode} auto_refresh=${config.auto_refresh}`);

  const nowSec = Math.floor(Date.now() / 1000);

  const creds = readCredentials(process.env);
  if (!creds) {
    log("[2] no credentials available");
    process.exit(0);
  }

  // トークンがまだ有効なら何もしない。無駄に claude -p を起動しない。
  if (!isTokenExpired(creds.expiresAt, nowSec)) {
    log("[2] token still valid, nothing to do");
    process.exit(0);
  }
  log("[2] token expired, refresh needed");

  const cooldown = readJson(resolveRefreshCooldownPath(process.env));
  if (!shouldAttemptRefresh({ cooldown, nowSec, config })) {
    log(`[3] within cooldown (last=${cooldown?.last_attempt_at}), skipping`);
    process.exit(0);
  }
  log("[3] cooldown clear");

  // [4] クールダウンは「試行前」に記録する（この順序は必須。成功後に移さないこと）:
  // 恒久的な認証失敗（ログアウト済み・サブスク失効など）では claude -p が毎回失敗する。
  // 成功時だけ記録する実装だと、セッションを開くたびに 60 秒かかる子プロセスが起動し続け、
  // 失敗プロセスを量産する。試行の事実を先に残すことで、失敗しても次の試行は
  // refresh_cooldown_sec まで抑制される。
  writeJsonAtomic(resolveRefreshCooldownPath(process.env), {
    version: 1,
    last_attempt_at: nowSec,
  });
  log("[4] recorded refresh attempt before trying");

  try {
    // claude -p を最小構成で 1 往復させ、CLI 自身にトークンを更新させる。
    //
    // --setting-sources "" と --strict-mcp-config は必須（絶対に削らないこと）:
    // 子 claude 側で設定・フック・MCP を全て無効化する。これが無いと子プロセスの
    // SessionStart でこの refresh.mjs 自身が再発火し、無限に claude -p が増殖する。
    // permission-gate / compact-handoff でも同じ理由で同じ組み合わせを使っている。
    // 「トークン更新に不要そうに見える」という理由で外してはいけない。
    execFileSync(
      "claude",
      [
        "-p",
        "ok",
        "--model",
        REFRESH_MODEL,
        "--max-turns",
        "1",
        "--setting-sources",
        "",
        "--strict-mcp-config",
      ],
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: REFRESH_TIMEOUT_MS,
      }
    );
    log("[5] claude -p succeeded (token refreshed by CLI)");
  } catch (err) {
    // 失敗しても何も出力しない。次回はクールダウン明けに再試行される。
    log(`[5] claude -p failed: ${err?.message ?? err}`);
    process.exit(0);
  }

  // 更新後のトークンで使用量を取り直す。readCredentials は fetchUsageIfStale 内で
  // 再度呼ばれるので、上で読んだ（更新前の古い）creds は渡さない。
  //
  // 注意: cache.json が fetch_ttl_sec 以内に取得済みだと、ここは TTL で短絡して
  // API を叩かない。これは guard.mjs と同じ取得処理を共有している当然の帰結であり、
  // 意図した挙動（次のプロンプトで TTL が切れれば取得される）。「バグ」として
  // TTL を回避する特別扱いを足さないこと。
  const nowSec2 = Math.floor(Date.now() / 1000);
  const cache = await fetchUsageIfStale(config, process.env, nowSec2, log);
  log(`[6] cache=${cache ? JSON.stringify(cache.windows ?? {}) : "null"}`);

  log(`=== usage-guard refresh hook finished: ${new Date().toISOString()} ===`);
  process.exit(0);
}

main().catch(() => process.exit(0));
