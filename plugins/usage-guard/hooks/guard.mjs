#!/usr/bin/env node
// usage-guard の判定フック。UserPromptSubmit と PostToolBatch の両方をこの 1 ファイルで処理する。
// 判定ロジックそのものは guard-shared.mjs の純関数に寄せ、ここは I/O とイベント制御だけを担う。
//
// 設計の大原則: どんな異常系でも「無出力 + exit 0」で終える。
// フックがクラッシュしたり想定外の JSON を吐くと Claude Code 本体の動作を壊すため、
// ガードの都合でユーザーの作業を止めない（fail-open）ことを常に優先する。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CC_VERSION,
  appendLogLine,
  buildCache,
  buildOutput,
  buildUserAgent,
  createLogger,
  evaluate,
  isBypassActive,
  isExemptPrompt,
  isTokenExpired,
  loadConfig,
  parseUsageResponse,
  parseVersionOutput,
  readJson,
  resolveConfigDir,
  readStdin,
  resolveBypassPath,
  resolveCachePath,
  resolveLogPath,
  writeJsonAtomic,
} from "./guard-shared.mjs";

// 使用量エンドポイント（OAuth トークンで叩く）。
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
// 使用量 API 呼び出しのタイムアウト。フックは同期的にユーザーを待たせるので短く保つ。
const FETCH_TIMEOUT_MS = 3_000;
// `claude --version` のタイムアウト。
const VERSION_TIMEOUT_MS = 3_000;
// Keychain 読み出しのタイムアウト。
// 内側の最悪合計（KEYCHAIN 4s + VERSION 3s + FETCH 3s = 10s）は、hooks.json の
// 外側 timeout（20 秒）に対して十分な余裕を持たせている。ここを伸ばして内側合計が
// 外側に近づくと、Node 起動・プロセス起動・TLS ハンドシェイク・ファイル I/O の
// オーバーヘッドが乗った時点で外側キルが先に発火し、stdout へ書く前に
// プロセスが死ぬ（＝enforce で超過中でも黙って通してしまう）。絶対に縮めないこと。
const KEYCHAIN_TIMEOUT_MS = 4_000;

// ---- 認証情報 ---------------------------------------------------------------

// アクセストークンと失効時刻を読み出す。取得できなければ null。
//
// 重要: このフックは認証情報を絶対に書き込まない（読み取り専用）。
// トークンのローテーションと Keychain への書き込みは Claude Code CLI 自身が所有しており、
// 別プロセスから書くと CLI 側の状態と食い違って認証が壊れる。
export function readCredentials(env = process.env) {
  let raw = null;

  if (process.platform === "darwin") {
    try {
      raw = execFileSync(
        "security",
        [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-a",
          os.userInfo().username,
          "-w",
        ],
        { timeout: KEYCHAIN_TIMEOUT_MS, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch {
      raw = null; // 下のファイルフォールバックへ
    }
  }

  let parsed = null;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  // macOS でも必ずファイルへフォールバックする（削らないこと）:
  // Claude Code 自身が Keychain への書き込みを拒否された環境では、CLI は
  // .credentials.json へ認証情報を書く。Keychain だけを見ていると
  // その環境で常に「認証情報なし」になり、ガードが恒久的に無効化される。
  // 探索先は resolveConfigDir を経由する: CLAUDE_CONFIG_DIR が設定されている場合、
  // Claude Code は .credentials.json もそのディレクトリ配下に置く（Keychain の
  // エントリもそのディレクトリでキーされる）ため、~/.claude 決め打ちでは見つからない。
  if (!parsed) {
    const configDir = resolveConfigDir(env);
    if (!configDir) return null;
    parsed = readJson(path.join(configDir, ".credentials.json"));
  }
  if (!parsed || typeof parsed !== "object") return null;

  const oauth = parsed.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;

  const token = oauth.accessToken;
  if (typeof token !== "string" || token.trim() === "") return null;

  // expiresAt はミリ秒。欠落・非数値でも token だけで動かす（isTokenExpired が false を返す）。
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;
  return { token, expiresAt };
}

// ---- 使用量の取得 -----------------------------------------------------------

// User-Agent 用の Claude Code バージョンを決める。
// 戻り値の fetched は「実際に `claude --version` を叩いたか」。叩いたときだけ
// キャッシュの cc_version_fetched_at を更新する（叩いていないなら prev の値を引き継ぐ）。
function resolveVersion(prev, config, nowSec, log) {
  const cachedAt = prev?.cc_version_fetched_at;
  if (
    typeof prev?.cc_version === "string" &&
    typeof cachedAt === "number" &&
    nowSec - cachedAt < config.version_ttl_sec
  ) {
    return { version: prev.cc_version, fetched: false };
  }

  try {
    const out = execFileSync("claude", ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseVersionOutput(out);
    if (parsed) return { version: parsed, fetched: true };
    log(`[fetch] unexpected --version output: ${JSON.stringify(out)}`);
  } catch (err) {
    log(`[fetch] claude --version failed: ${err?.message ?? err}`);
  }
  // 最後の保険。バージョン検出に失敗しただけで使用量取得を諦めはしない。
  return { version: DEFAULT_CC_VERSION, fetched: false };
}

// キャッシュが古ければ使用量 API を叩き、キャッシュを更新して返す。
// 戻り値は「判定に使うキャッシュオブジェクト」。取得できなければ前回キャッシュ（無ければ null）。
//
// 取得失敗時に prev をそのまま返すのが要点: 一時的な 401/429/ネットワーク断で
// キャッシュを空にしてしまうと、超過中でもガードが黙って無効化される。
// 取得に失敗したときも「試行した時刻」を記録して TTL を進める。
// これが無いと、認証切れやネットワーク障害が続く間は毎ツールバッチごとに
// Keychain 起動 → claude --version 起動 → fetch(最大3秒) のフルチェーンを
// 際限なく繰り返すことになる（ホットパスなので体感遅延が積み上がる）。
// 使用量の値そのものは prev のまま据え置くので、判定の安全性は変わらない。
function markAttempt(env, prev, nowSec) {
  const base = prev && typeof prev === "object" ? prev : { version: 1, windows: {} };
  const next = { ...base, fetched_at: nowSec };
  writeJsonAtomic(resolveCachePath(env), next);
  return next;
}

export async function fetchUsageIfStale(config, env, nowSec, log) {
  let prev = null;
  try {
    prev = readJson(resolveCachePath(env));

    // 1. TTL 内なら API を叩かない。フックは毎プロンプト・毎ツールバッチで走るので、
    //    ここでの短絡がレイテンシとレート制限の両方を守っている。
    if (typeof prev?.fetched_at === "number" && nowSec - prev.fetched_at < config.fetch_ttl_sec) {
      log(`[fetch] cache fresh (age=${nowSec - prev.fetched_at}s < ${config.fetch_ttl_sec}s)`);
      return prev;
    }

    // 2. 認証情報が無ければ何もできない。fail-open で prev を返す。
    const creds = readCredentials(env);
    if (!creds) {
      log("[fetch] no credentials available");
      return markAttempt(env, prev, nowSec);
    }

    // 3. 失効済みトークンでは 401 が確定しているので API を叩かない
    //    （3 秒の無駄な往復でユーザーを待たせない）。リフレッシュは refresh.mjs の担当。
    if (isTokenExpired(creds.expiresAt, nowSec)) {
      log("[fetch] token expired, skipping API call");
      return markAttempt(env, prev, nowSec);
    }

    // 4. User-Agent 用バージョン。
    const { version, fetched: versionFetched } = resolveVersion(prev, config, nowSec, log);

    // 5. 使用量取得。
    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": buildUserAgent(version),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 401（失効）/ 429（レート制限）/ 5xx いずれもキャッシュの既存値で判定を続ける。
      log(`[fetch] HTTP ${res.status}, keeping previous cache`);
      return markAttempt(env, prev, nowSec);
    }

    const payload = await res.json();
    const windows = parseUsageResponse(payload);
    if (!windows) {
      // レスポンス形状が変わった等。欠落を 0% と解釈しないため prev を維持する。
      log("[fetch] no valid windows in response, keeping previous cache");
      return markAttempt(env, prev, nowSec);
    }

    const next = buildCache(windows, nowSec, prev ?? {});
    next.cc_version = version;
    // 実際に --version を叩いたときだけ時刻を更新する。叩いていない場合は
    // buildCache が prev から引き継いだ値をそのまま残す（TTL を無意味に延ばさない）。
    if (versionFetched) next.cc_version_fetched_at = nowSec;
    writeJsonAtomic(resolveCachePath(env), next);
    log(`[fetch] updated cache: ${JSON.stringify(windows)}`);
    return next;
  } catch (err) {
    // fetch のタイムアウト・DNS 失敗などもここに来る。ネットワーク障害が続く間、
    // 毎ツールバッチでフルチェーンを繰り返さないよう試行時刻を記録する。
    log(`[fetch] unexpected error: ${err?.message ?? err}`);
    try {
      return markAttempt(env, prev, nowSec);
    } catch {
      return prev;
    }
  }
}

// ---- エントリポイント -------------------------------------------------------

async function main() {
  const log = createLogger(process.env);
  log(`=== usage-guard guard hook started: ${new Date().toISOString()} ===`);

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log("[1] failed to parse JSON input");
    process.exit(0);
  }

  const eventName = payload?.hook_event_name;
  if (eventName !== "UserPromptSubmit" && eventName !== "PostToolBatch") {
    log(`[2] unsupported event: ${eventName}`);
    process.exit(0);
  }
  log(`[2] event=${eventName} agent=${payload?.agent_type ?? "main"}`);

  // [3] 免除判定は他の一切の処理より先に行う（この順序は必須。絶対に後ろへ動かさないこと）:
  // enforce モードで閾値を超過している間、このフックは UserPromptSubmit を全てブロックする。
  // 「/usage-guard:usage-guard-bypass 30m」というバイパス操作もプロンプトなので、
  // 免除が無いとバイパス自体がブロックされ、ユーザーは設定ファイルを手で編集する以外に
  // 復帰手段を失う（＝デッドロック）。
  // config も cache も読まずに即 exit するのは、設定や API の異常でこの脱出経路が
  // 塞がることを防ぐため。
  if (eventName === "UserPromptSubmit" && isExemptPrompt(payload?.prompt)) {
    log("[3] exempt prompt, exiting without evaluation");
    process.exit(0);
  }

  const config = loadConfig(process.env);
  log(`[4] mode=${config.mode} thresholds=${JSON.stringify(config.thresholds)}`);

  // mode: off では API も叩かない（完全に無効化されている状態でネットワーク I/O をしない）。
  if (config.mode === "off") {
    log("[5] mode is off, exiting");
    process.exit(0);
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // [6] 使用量を見なくても allow が確定するケースを先に短絡する。
  // バイパス中とサブエージェント除外は config と stdin だけで判定できるので、
  // Keychain 起動・claude --version 起動・fetch を丸ごと省ける
  // （バイパス中は毎ツールバッチでこのチェーンを回す価値がない）。
  const bypass = readJson(resolveBypassPath(process.env));
  log(`[6] bypass=${bypass ? JSON.stringify(bypass) : "none"}`);
  if (isBypassActive(bypass, nowSec)) {
    log("[6] bypass active, exiting without fetching usage");
    process.exit(0);
  }
  if (payload?.agent_type && config.guard_subagents === false) {
    log("[6] subagent excluded by guard_subagents, exiting without fetching usage");
    process.exit(0);
  }

  const cache = await fetchUsageIfStale(config, process.env, nowSec, log);
  log(`[7] cache=${cache ? JSON.stringify(cache.windows ?? {}) : "null"}`);

  const ev = evaluate({
    cache,
    config,
    bypass,
    nowSec,
    agentType: payload?.agent_type,
    env: process.env,
  });
  log(`[8] action=${ev.action} exceeded=${ev.exceeded.map((w) => w.key).join(",") || "none"}`);

  // [9] 監査ログ。ブロックは実績として必ず残す。warn は PostToolBatch のときだけ残す
  // （PostToolBatch の warn は buildOutput が何も出さないため、ログだけが痕跡になる。
  // UserPromptSubmit の warn は systemMessage としてユーザーに見えるので二重記録しない）。
  if (ev.action === "block" || (ev.action === "warn" && eventName === "PostToolBatch")) {
    appendLogLine(resolveLogPath(process.env), {
      ts: new Date().toISOString(),
      event: eventName,
      mode: config.mode,
      action: ev.action,
      agent_type: payload?.agent_type ?? null,
      exceeded: ev.exceeded.map((w) => ({
        key: w.key,
        utilization: w.utilization,
        threshold: w.threshold,
      })),
      tool_call_count: payload?.tool_calls?.length,
    });
    log("[9] appended audit log line");
  }

  const out = buildOutput(ev, eventName);
  if (!out) {
    log("[10] no output");
    process.exit(0);
  }

  // stdout がパイプのとき write は非同期になりうる（macOS で顕著）。
  // 書き込み完了のコールバックで exit しないと、複数行の stopReason が途中で切れる。
  process.stdout.write(JSON.stringify(out), () => {
    log(`[10] emitted output for ${eventName}`);
    process.exit(0);
  });
}

// 直接実行されたときだけ main() を走らせる。
// refresh.mjs がこのファイルから fetchUsageIfStale / readCredentials を import するため、
// import 時に main() が走ってはいけない（stdin 待ちで固まる）。
//
// realpath で比較するのは必須（削らないこと）: import.meta.url はシンボリックリンクを
// 解決した実パスだが process.argv[1] は解決されない。プラグインが symlink 経由で
// 配置されていると単純比較では一致せず、main() が一度も走らないまま exit 0 する
// ＝ ガードが黙って無効化される（「許可」と区別できない）。
function isDirectRun() {
  const self = fileURLToPath(import.meta.url);
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (argv1 === self) return true;
  try {
    return fs.realpathSync(argv1) === self;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch(() => process.exit(0));
}
