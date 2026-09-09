#!/usr/bin/env node
// usage-guard の中核モジュール。純関数群のみを置き、import 時の副作用はゼロにする
// （スキル・複数のフックから import されるため、ここで I/O や process.exit をしてはいけない）。
// main() 相当のエントリポイントは各フック側に置く。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 既定の設定。config.json（~/.claude/usage-guard/config.json）で個別キーを上書きできる。
// mode: "off"（無効） / "dry-run"（警告のみ） / "enforce"（実際に停止）
// thresholds: ウィンドウごとの停止閾値（%）。null にするとそのウィンドウを無視する。
// guard_subagents: サブエージェント（agent_type あり）にもガードを適用するか。
// fetch_ttl_sec: 使用量 API のキャッシュ有効期間（秒）。
// version_ttl_sec: User-Agent 用 CLI バージョンのキャッシュ有効期間（秒）。
// auto_refresh: アクセストークン失効時に自動リフレッシュを試みるか。
// refresh_cooldown_sec: リフレッシュ試行の最小間隔（秒）。失敗連打を防ぐ。
export const DEFAULT_CONFIG = {
  mode: "dry-run",
  thresholds: { five_hour: 90, seven_day: 95 },
  guard_subagents: true,
  fetch_ttl_sec: 60,
  version_ttl_sec: 86_400,
  auto_refresh: true,
  refresh_cooldown_sec: 600,
};

// mode の許容値。これ以外は "dry-run" にフォールバックする（誤設定で意図せず enforce にならないように）。
const VALID_MODES = ["off", "dry-run", "enforce"];

// 免除プロンプトの接頭辞。これで始まるプロンプトはガード対象外。
export const EXEMPT_PROMPT_PREFIX = "/usage-guard";

// User-Agent に載せる Claude Code バージョンの最終フォールバック。
// 通常経路ではキャッシュ or `claude --version` の実測値を使うので、これが使われるのは
// 両方失敗したときだけ（「最後の保険」）。
export const DEFAULT_CC_VERSION = "2.1.266";

// レスポンスのウィンドウキー → 人間可読なラベル。reason 文の組み立てに使う。
export const WINDOW_LABELS = {
  five_hour: "5時間枠",
  seven_day: "週次枠",
};

// ---- パス解決 ---------------------------------------------------------------
// os.homedir() を関数内で直接呼ばず env を注入させる（テストで一時ディレクトリに差し替えるため）。

// Claude Code の設定ディレクトリ。既定は ~/.claude だが、CLAUDE_CONFIG_DIR が
// 設定されていればそちらが正となる（設定・履歴・プラグイン・.credentials.json の
// 保存先がすべて移動する。複数アカウントを併用する運用で使われる）。
// ここを ~/.claude 決め打ちにすると、CLAUDE_CONFIG_DIR を使う環境で
// 「設定を書いたのに読まれない」「認証情報が見つからずガードが常に fail-open」
// という食い違いが起きるため、必ずこの関数を経由すること。
export function resolveConfigDir(env = {}) {
  const override = env.CLAUDE_CONFIG_DIR;
  if (typeof override === "string" && override.trim()) return override.trim();
  return path.join(env.HOME || env.USERPROFILE || "", ".claude");
}

// 機械が管理するファイル（cache / bypass / log / refresh-cooldown）の置き場所。
// CLAUDE_PLUGIN_DATA（プラグイン専用の永続データディレクトリ）を優先する。
// プラグイン更新をまたいで残り、Claude Code がフックプロセスとスキル本文の
// 両方に渡してくれるため、フック側とスキル側で同じ場所を指せる。
// 既にプラグイン単位でスコープされているので、さらに "usage-guard" を掘らない。
// 未設定の環境（フック以外から直接叩いた場合など）では設定ディレクトリ配下に
// フォールバックする。
export function resolveDir(env = {}) {
  const data = env.CLAUDE_PLUGIN_DATA;
  if (typeof data === "string" && data.trim()) return data.trim();
  return path.join(resolveConfigDir(env), "usage-guard");
}

// ユーザーが手で編集する設定ファイルだけは、データディレクトリではなく
// 設定ディレクトリ直下に置く（既存の permission-gate.md と同じ流儀）。
// 理由が2つある:
//   1. CLAUDE_PLUGIN_DATA の実ディレクトリ名はハッシュを含むため、ユーザーが
//      パスを推測して設定を置けない
//   2. CLAUDE_PLUGIN_DATA はアンインストール時に既定で削除されるため、
//      ユーザーが書いた設定が一緒に消える
// 機械が管理するファイル（cache 等）は消えても再生成されるので data 側でよい。
export function resolveConfigPath(env = {}) {
  return path.join(resolveConfigDir(env), "usage-guard.json");
}

export function resolveCachePath(env = {}) {
  return path.join(resolveDir(env), "cache.json");
}

export function resolveBypassPath(env = {}) {
  return path.join(resolveDir(env), "bypass.json");
}

export function resolveLogPath(env = {}) {
  return path.join(resolveDir(env), "usage.log");
}

// トークンリフレッシュの最終試行時刻を記録するファイル。クールダウン判定に使う。
export function resolveRefreshCooldownPath(env = {}) {
  return path.join(resolveDir(env), "refresh-cooldown.json");
}

// ---- JSON I/O ---------------------------------------------------------------

// JSON ファイルを読む。不在・壊れた JSON はいずれも null（fail-safe）。
// ガードの入力が壊れていてもフックを落とさないことが最優先。
export function readJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// JSON をアトミックに書く（tmp へ書いて rename）。成功で true、失敗は例外を投げず false。
export function writeJsonAtomic(filePath, obj) {
  let tmp;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // tmp 名に process.pid を含めるのは必須（削らないこと）:
    // 複数の Claude Code セッションが同時にキャッシュを更新しうるため、固定の tmp 名だと
    // セッションAの書き込み途中のファイルをセッションBが rename してしまい、
    // 壊れた（部分書き込みの）JSON が本ファイルとして残る。pid で tmp 名を分離して防ぐ。
    tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    // 書き込み失敗はガードの停止理由にしない（キャッシュが効かず次回再取得するだけ）。
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 後始末の失敗も無視
      }
    }
    return false;
  }
}

// 監査用の JSONL ログを 1 行追記する。失敗は無視（ログのためにフックを止めない）。
export function appendLogLine(logPath, obj) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(obj) + "\n");
  } catch {
    // 無視
  }
}

// ---- 設定 -------------------------------------------------------------------

// 0-100 にクランプした数値、または null（＝そのウィンドウを無視）を返す。
function normalizeThreshold(value) {
  const n = normalizeNumber(value, null);
  if (n === null) return null;
  return Math.min(100, Math.max(0, n));
}

// 数値系設定の正規化。非数値・非有限は既定値へ。
function normalizeNumber(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

// 生の config を既定値へマージして正規化する。未知キーは捨てる（設定ミスを静かに引きずらない）。
export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};

  const mode = VALID_MODES.includes(src.mode) ? src.mode : DEFAULT_CONFIG.mode;

  const rawThresholds =
    src.thresholds && typeof src.thresholds === "object" ? src.thresholds : {};
  const thresholds = {};
  for (const key of Object.keys(DEFAULT_CONFIG.thresholds)) {
    // キー未指定なら既定値、指定ありなら正規化（非数値は null＝無視）。
    thresholds[key] = Object.hasOwn(rawThresholds, key)
      ? normalizeThreshold(rawThresholds[key])
      : DEFAULT_CONFIG.thresholds[key];
  }

  return {
    mode,
    thresholds,
    guard_subagents:
      typeof src.guard_subagents === "boolean"
        ? src.guard_subagents
        : DEFAULT_CONFIG.guard_subagents,
    fetch_ttl_sec: normalizeNumber(src.fetch_ttl_sec, DEFAULT_CONFIG.fetch_ttl_sec),
    version_ttl_sec: normalizeNumber(src.version_ttl_sec, DEFAULT_CONFIG.version_ttl_sec),
    auto_refresh:
      typeof src.auto_refresh === "boolean" ? src.auto_refresh : DEFAULT_CONFIG.auto_refresh,
    refresh_cooldown_sec: normalizeNumber(
      src.refresh_cooldown_sec,
      DEFAULT_CONFIG.refresh_cooldown_sec
    ),
  };
}

// config.json を読んで正規化する。不在・壊れていれば既定値。
export function loadConfig(env = {}) {
  return normalizeConfig(readJson(resolveConfigPath(env)) ?? {});
}

// ---- 免除判定 ---------------------------------------------------------------

// "/usage-guard..." で始まるプロンプトをガード対象外にする。
// これはバイパスのデッドロック回避の要（絶対に削らないこと）:
// enforce モードで閾値超過中は UserPromptSubmit フックが全プロンプトをブロックするため、
// この免除が無いと「/usage-guard:usage-guard-bypass 30m」というバイパス操作そのものが
// ブロックされ、ユーザーは設定ファイルを手で編集する以外に復帰手段が無くなる。
export function isExemptPrompt(prompt) {
  if (typeof prompt !== "string") return false;
  return prompt.trimStart().startsWith(EXEMPT_PROMPT_PREFIX);
}

// ---- レスポンス解析 ---------------------------------------------------------

// 1 ウィンドウ分を正規化する。無効なら null。
function parseWindow(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  // 消費率のキーは utilization（used_percentage ではない。実測で確定済み）。
  // typeof true === "boolean" なので数値判定で boolean は自然に除外される。
  if (typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization)) return null;
  // resets_at は ISO 8601 文字列（epoch 数値ではない）。内部表現は epoch 秒に統一する。
  if (typeof raw.resets_at !== "string") return null;
  const ms = Date.parse(raw.resets_at);
  if (!Number.isFinite(ms)) return null;
  return { utilization: raw.utilization, resets_at: Math.floor(ms / 1000) };
}

// 使用量 API のレスポンスから five_hour / seven_day を取り出して正規化する。
// 有効なウィンドウが 1 つも無ければ null。
// 重要: 欠落したウィンドウ（null や不正形）を「消費率 0%」と解釈してはいけない。
// 0% と誤解すると「未超過」と判定してガードが黙って無効化される。欠落は欠落として落とし、
// 上位（activeWindows / evaluate）で「判定材料が無い＝通す」に倒す。
export function parseUsageResponse(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;

  const windows = {};
  for (const key of Object.keys(WINDOW_LABELS)) {
    const parsed = parseWindow(payload[key]);
    if (parsed) windows[key] = parsed;
  }
  if (Object.keys(windows).length === 0) return null;
  return windows;
}

// キャッシュファイルの中身を組み立てる。cc_version 系は前回キャッシュから引き継ぐ
// （使用量の再取得だけでバージョン検出をやり直さないため）。
export function buildCache(windows, nowSec, prev = {}) {
  const cache = {
    version: 1,
    fetched_at: nowSec,
    windows,
  };
  if (prev && typeof prev === "object") {
    if (typeof prev.cc_version === "string") cache.cc_version = prev.cc_version;
    if (typeof prev.cc_version_fetched_at === "number") {
      cache.cc_version_fetched_at = prev.cc_version_fetched_at;
    }
  }
  return cache;
}

// ---- バージョン（User-Agent 用） --------------------------------------------

// `claude --version` の出力（例: "2.1.266 (Claude Code)"）から semver 部分だけを取り出す。
export function parseVersionOutput(output) {
  if (typeof output !== "string") return null;
  const m = output.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function buildUserAgent(version) {
  return `claude-code/${version}`;
}

// ---- 判定 -------------------------------------------------------------------

// キャッシュ済みウィンドウのうち、まだリセットされていない（有効な）ものだけを返す。
export function activeWindows(cache, nowSec) {
  const windows = cache?.windows;
  if (!windows || typeof windows !== "object") return [];

  const result = [];
  for (const [key, win] of Object.entries(windows)) {
    if (!win || typeof win !== "object") continue;
    // resets_at が数値でないものは「判定不能」として除外する＝通す側に倒す
    // （壊れたキャッシュでユーザーを永久にブロックしないため）。
    if (typeof win.resets_at !== "number" || !Number.isFinite(win.resets_at)) continue;
    if (!(win.resets_at > nowSec)) continue; // 既にリセット済みの枠は無関係
    if (typeof win.utilization !== "number" || !Number.isFinite(win.utilization)) continue;
    result.push({ key, utilization: win.utilization, resets_at: win.resets_at });
  }
  return result;
}

// 閾値を超過しているウィンドウを、超過幅の降順（最も深刻なものが先頭）で返す。
export function exceededWindows(windows, thresholds) {
  const list = Array.isArray(windows) ? windows : [];
  const table = thresholds && typeof thresholds === "object" ? thresholds : {};

  return list
    .map((win) => {
      const threshold = table[win.key];
      // 閾値が数値でない（null 含む）ウィンドウは意図的に無視する設定なので判定対象外。
      if (typeof threshold !== "number" || !Number.isFinite(threshold)) return null;
      if (!(win.utilization >= threshold)) return null;
      return { ...win, threshold };
    })
    .filter(Boolean)
    .sort((a, b) => b.utilization - b.threshold - (a.utilization - a.threshold));
}

// バイパスが有効か。until（epoch 秒）が現在より未来のときだけ true。
export function isBypassActive(bypass, nowSec) {
  const until = bypass?.until;
  if (typeof until !== "number" || !Number.isFinite(until)) return false;
  return until > nowSec;
}

// アクセストークンが（marginSec 前倒しで）失効しているか。
// expiresAtMs はミリ秒なので 1000 で割って秒に直す。
// expiresAt が欠落・非数値のときは false（失効扱いにしない）:
// 判定材料が無いだけで無用なリフレッシュを走らせるより、そのまま使って
// 401 が返ったら上位で対処する方が副作用が小さい。
export function isTokenExpired(expiresAtMs, nowSec, marginSec = 300) {
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs / 1000 - marginSec <= nowSec;
}

// トークンリフレッシュを試みてよいか。auto_refresh 無効時とクールダウン中は false。
export function shouldAttemptRefresh({ cooldown, nowSec, config }) {
  if (config?.auto_refresh === false) return false;
  const last = cooldown?.last_attempt_at;
  if (typeof last === "number" && Number.isFinite(last)) {
    const cooldownSec = normalizeNumber(
      config?.refresh_cooldown_sec,
      DEFAULT_CONFIG.refresh_cooldown_sec
    );
    if (nowSec - last < cooldownSec) return false;
  }
  return true;
}

// ガード判定の本体。I/O を一切しない純関数（テスト容易性と、フック側での差し替えのため）。
// 戻り値の action は "allow"（何もしない） / "warn"（dry-run 通知） / "block"（停止）。
export function evaluate({ cache, config, bypass, nowSec, agentType, env }) {
  const cfg = config ?? DEFAULT_CONFIG;

  // 使用量を見る前に allow が確定するケース:
  //   - mode: off（完全無効）
  //   - バイパス期間中
  //   - サブエージェント内かつ guard_subagents: false
  // いずれも config と stdin だけで判定でき、同じ「無条件許可」に帰着する。
  if (
    cfg.mode === "off" ||
    isBypassActive(bypass, nowSec) ||
    (agentType && cfg.guard_subagents === false)
  ) {
    return { action: "allow", exceeded: [], windows: [], reason: "" };
  }

  // 有効ウィンドウが無い（キャッシュ無し・全枠リセット済み）なら許可＝fail-open。
  // 使用量が取得できないことを理由にユーザーの作業を止めない。
  const windows = activeWindows(cache, nowSec);
  const exceeded = exceededWindows(windows, cfg.thresholds);
  if (exceeded.length === 0) {
    return { action: "allow", exceeded: [], windows, reason: "" };
  }

  // 超過あり。enforce なら停止、それ以外（dry-run）は警告のみ。
  // configPath は実際に読んでいるパスを渡す（HOME が既定でない環境でも
  // ユーザーが編集すべきファイルを正しく案内できるようにする。
  // ブロック中はこの文字列だけが復帰手段の案内になる）。
  const reason = formatReason({
    exceeded,
    windows,
    config: cfg,
    nowSec,
    agentType,
    configPath: env ? resolveConfigPath(env) : undefined,
  });
  return {
    action: cfg.mode === "enforce" ? "block" : "warn",
    exceeded,
    windows,
    reason,
  };
}

// ---- 書式 -------------------------------------------------------------------

// 秒数を日本語の相対時間表記にする。24時間以上は「6日23時間」、1時間以上は「1時間24分」、
// それ未満は「3分」。0以下は「0分」。
export function formatDuration(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return "0分";
  const total = Math.floor(sec);
  const days = Math.floor(total / 86_400);
  if (days >= 1) {
    const hours = Math.floor((total % 86_400) / 3_600);
    return `${days}日${hours}時間`;
  }
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (hours >= 1) return `${hours}時間${minutes}分`;
  return `${minutes}分`;
}

const pad2 = (n) => String(n).padStart(2, "0");

// epoch 秒を「2026-09-09 18:30 (あと1時間24分)」形式にする。
// Intl は使わず手組みする（実行環境のロケール・タイムゾーン設定によって表記が揺れると
// ログや reason 文の比較・テストが不安定になるため）。日付部分はローカルタイム。
// 絶対時刻だけを整形する。formatResetAt の出力から呼び出し側が文字列分割で
// 絶対時刻を取り出そうとすると、こちらの書式変更で黙って壊れるため、
// 「絶対時刻だけ欲しい」用途にはこの関数を使うこと。
export function formatAbsTime(epochSec) {
  const d = new Date(epochSec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatResetAt(epochSec, nowSec) {
  return `${formatAbsTime(epochSec)} (あと${formatDuration(epochSec - nowSec)})`;
}

const labelOf = (key) => WINDOW_LABELS[key] ?? key;

// ブロック理由（＝ユーザーに見える唯一の説明）を組み立てる。
// これ単体で判断に必要な全情報を含めること（絶対に情報を削らないこと）:
// 超過してブロックされている間は status スキルの出力もモデル経由でリレーされない可能性があり、
// この文字列だけがユーザーに届く。「なぜ止まったか」「いつ復帰するか」「どう回避するか」
// 「どこを設定するか」が全て揃っていないと、ユーザーは復帰手段を持てない。
export function formatReason({ exceeded, windows, config, nowSec, agentType, configPath }) {
  const cfg = config ?? DEFAULT_CONFIG;
  const exceededList = Array.isArray(exceeded) ? exceeded : [];
  const allWindows = Array.isArray(windows) ? windows : [];

  const lines = [];
  // 見出しは mode で変える。dry-run ではこの文字列は systemMessage として出るだけで
  // プロンプトは通るので、「停止しました」と書くと事実と食い違う。
  lines.push(
    cfg.mode === "enforce"
      ? "usage-guard: Claude の使用量が設定した閾値を超えたため停止しました。"
      : "usage-guard: Claude の使用量が設定した閾値を超えています（dry-run のため停止しません）。"
  );

  for (const win of exceededList) {
    lines.push(
      `- ${labelOf(win.key)}: 消費率 ${win.utilization}%（閾値 ${win.threshold}%）／リセット ${formatResetAt(win.resets_at, nowSec)}`
    );
  }

  // 未超過ウィンドウも併記する（「週次枠はまだ余裕がある」等の判断材料になる）。
  const exceededKeys = new Set(exceededList.map((w) => w.key));
  const others = allWindows.filter((w) => !exceededKeys.has(w.key));
  if (others.length > 0) {
    lines.push("未超過のウィンドウ:");
    for (const win of others) {
      const threshold = cfg.thresholds?.[win.key];
      const thresholdText =
        typeof threshold === "number" ? `閾値 ${threshold}%` : "閾値なし（無視設定）";
      lines.push(
        `- ${labelOf(win.key)}: 消費率 ${win.utilization}%（${thresholdText}）／リセット ${formatResetAt(win.resets_at, nowSec)}`
      );
    }
  }

  lines.push("");
  lines.push("一時的に解除するには次を実行してください:");
  lines.push("  /usage-guard:usage-guard-bypass 30m");
  lines.push(`現在の mode: ${cfg.mode}`);
  lines.push(`設定ファイル: ${configPath ?? "~/.claude/usage-guard/config.json"}`);
  if (agentType) {
    lines.push(`対象: サブエージェント (${agentType})`);
  }

  return lines.join("\n");
}

// ---- 出力組み立て -----------------------------------------------------------

// evaluate の結果をフックイベントごとの JSON 出力に変換する。
// null は「何も出力しない（exit 0 のみ）」を意味する。
export function buildOutput(evaluation, eventName) {
  const action = evaluation?.action;
  if (!action || action === "allow") return null;
  const reason = evaluation.reason ?? "";

  if (eventName === "UserPromptSubmit") {
    if (action === "block") {
      return { decision: "block", reason };
    }
    // dry-run はプロンプトを通しつつユーザーにだけ知らせる。
    // additionalContext は使わない（モデルのコンテキストを汚さず、通知はユーザー向けに限る）。
    return { systemMessage: `[usage-guard dry-run] ${reason}` };
  }

  if (eventName === "PostToolBatch") {
    if (action === "block") {
      return { continue: false, stopReason: reason };
    }
    // warn では何も出力しない: PostToolBatch はツール実行バッチごとに発火するため、
    // systemMessage を出すと同じ警告が延々と繰り返されてスパムになる。
    // dry-run の記録はログ（appendLogLine）で担保し、そちらは呼び出し側の責務とする。
    return null;
  }

  // 未対応イベントでは何も出力しない（想定外の形の JSON を吐かない）。
  return null;
}

// ---- バイパス期間 -----------------------------------------------------------

// 既定のバイパス期間（分）。引数省略時に使う。
const DEFAULT_BYPASS_MINUTES = 30;

// バイパス期間の引数を解釈する。
// "30m" / "2h" / "90"（分として解釈）/ "reset"（5時間枠のリセットまで）/ "off"（解除）/
// 未指定（30分）。解釈できなければ null。
export function parseDuration(arg, cache, nowSec) {
  if (arg === null || arg === undefined || String(arg).trim() === "") {
    const minutes = DEFAULT_BYPASS_MINUTES;
    return { until: nowSec + minutes * 60, label: `${minutes}m` };
  }

  const raw = String(arg).trim().toLowerCase();

  if (raw === "off") {
    // until: 0 は「過去」なので isBypassActive が常に false になる＝即時解除。
    return { until: 0, label: "off" };
  }

  if (raw === "reset") {
    const resetsAt = cache?.windows?.five_hour?.resets_at;
    if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
    return { until: resetsAt, label: "reset" };
  }

  const m = raw.match(/^(\d+(?:\.\d+)?)(m|h)?$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2] ?? "m"; // 単位なしは分として解釈（"90" → 90分）
  const seconds = unit === "h" ? value * 3_600 : value * 60;
  return { until: Math.round(nowSec + seconds), label: `${m[1]}${unit}` };
}

// ---- その他 -----------------------------------------------------------------

// stdin を全部読む。"error" でも resolve する堅牢版
// （stdin が閉じている・パイプが壊れているケースでフックが hang しないため）。
export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// デバッグログの書き出し先を決める。既定（USAGE_GUARD_DEBUG 未設定）は null＝ログ無効。
// 有効時は USAGE_GUARD_DEBUG_FILE、無指定なら OS の temp ディレクトリに書く。
function resolveDebugLogPath(env = {}) {
  if (!env.USAGE_GUARD_DEBUG) return null;
  const override = env.USAGE_GUARD_DEBUG_FILE;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.tmpdir(), "usage-guard-debug.log");
}

// デバッグログ用の log 関数を作る。resolveDebugLogPath が null（未設定）のときは no-op。
export function createLogger(env = {}) {
  const logPath = resolveDebugLogPath(env);
  return (msg) => {
    if (!logPath) return;
    try {
      fs.appendFileSync(logPath, msg + "\n");
    } catch {
      // ログ失敗は無視（フック本体を止めない）
    }
  };
}

// ---- インラインテスト --------------------------------------------------------
// import されたときに走らないよう、直接実行時のみに限定する（このガードは必須）。
if (process.env.NODE_TEST_CONTEXT && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  const NOW = 1_800_000_000; // 固定の基準時刻（epoch 秒）
  const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "usage-guard-test-"));

  // 実測のレスポンス形状（five_hour / seven_day は null になりうる）。
  const REAL_PAYLOAD = {
    five_hour: {
      utilization: 22.0,
      resets_at: "2026-08-20T09:39:59.874301+00:00",
      limit_dollars: null,
    },
    seven_day: {
      utilization: 21.0,
      resets_at: "2026-08-26T00:59:59.874333+00:00",
      limit_dollars: null,
    },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [],
  };

  // ---- resolveX ----
  test("resolveDir: env.HOME 配下の .claude/usage-guard を返す", () => {
    assert.equal(resolveDir({ HOME: "/h" }), path.join("/h", ".claude", "usage-guard"));
  });

  test("resolveDir: HOME 未設定なら USERPROFILE を使う", () => {
    assert.equal(resolveDir({ USERPROFILE: "/u" }), path.join("/u", ".claude", "usage-guard"));
  });

  test("resolveDir: CLAUDE_PLUGIN_DATA があれば最優先で使う", () => {
    assert.equal(
      resolveDir({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_PLUGIN_DATA: "/data" }),
      "/data"
    );
  });

  test("resolveDir: CLAUDE_PLUGIN_DATA が空白のみなら設定ディレクトリにフォールバック", () => {
    assert.equal(
      resolveDir({ HOME: "/h", CLAUDE_PLUGIN_DATA: "   " }),
      path.join("/h", ".claude", "usage-guard")
    );
  });

  test("resolveDir: CLAUDE_CONFIG_DIR があれば HOME より優先する", () => {
    assert.equal(
      resolveDir({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" }),
      path.join("/cfg", "usage-guard")
    );
  });

  test("resolveDir: CLAUDE_CONFIG_DIR が空白のみなら HOME にフォールバックする", () => {
    assert.equal(
      resolveDir({ HOME: "/h", CLAUDE_CONFIG_DIR: "   " }),
      path.join("/h", ".claude", "usage-guard")
    );
  });

  test("resolveConfigDir: 既定は HOME 配下の .claude", () => {
    assert.equal(resolveConfigDir({ HOME: "/h" }), path.join("/h", ".claude"));
  });

  test("resolveConfigDir: CLAUDE_CONFIG_DIR は前後の空白を除いて使う", () => {
    assert.equal(resolveConfigDir({ HOME: "/h", CLAUDE_CONFIG_DIR: " /cfg " }), "/cfg");
  });

  test("機械管理のファイルはデータディレクトリ配下に置く", () => {
    const env = { HOME: "/h" };
    const dir = resolveDir(env);
    assert.equal(resolveCachePath(env), path.join(dir, "cache.json"));
    assert.equal(resolveBypassPath(env), path.join(dir, "bypass.json"));
    assert.equal(resolveLogPath(env), path.join(dir, "usage.log"));
    assert.equal(resolveRefreshCooldownPath(env), path.join(dir, "refresh-cooldown.json"));
  });

  test("resolveConfigPath: 設定は設定ディレクトリ直下の usage-guard.json", () => {
    assert.equal(
      resolveConfigPath({ HOME: "/h" }),
      path.join("/h", ".claude", "usage-guard.json")
    );
  });

  test("resolveConfigPath: CLAUDE_PLUGIN_DATA に影響されない（消えては困るため）", () => {
    const env = { HOME: "/h", CLAUDE_PLUGIN_DATA: "/data" };
    assert.equal(resolveConfigPath(env), path.join("/h", ".claude", "usage-guard.json"));
    // 機械管理側は data 配下へ分かれる
    assert.equal(resolveCachePath(env), path.join("/data", "cache.json"));
  });

  test("resolveConfigPath: CLAUDE_CONFIG_DIR に追従する", () => {
    assert.equal(
      resolveConfigPath({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" }),
      path.join("/cfg", "usage-guard.json")
    );
  });

  // ---- isExemptPrompt ----
  test("isExemptPrompt: バイパスコマンドは免除", () => {
    assert.equal(isExemptPrompt("/usage-guard:usage-guard-bypass 30m"), true);
  });

  test("isExemptPrompt: /usage-guard-status も免除", () => {
    assert.equal(isExemptPrompt("/usage-guard-status"), true);
  });

  test("isExemptPrompt: 先頭空白があっても免除", () => {
    assert.equal(isExemptPrompt("   /usage-guard:usage-guard-bypass 2h"), true);
    assert.equal(isExemptPrompt("\n\t/usage-guard-status"), true);
  });

  test("isExemptPrompt: 無関係なプロンプトは免除しない", () => {
    assert.equal(isExemptPrompt("バグを直して"), false);
    assert.equal(isExemptPrompt("run /usage-guard-status"), false);
  });

  test("isExemptPrompt: 空文字は免除しない", () => {
    assert.equal(isExemptPrompt(""), false);
    assert.equal(isExemptPrompt("   "), false);
  });

  test("isExemptPrompt: 非文字列は false", () => {
    assert.equal(isExemptPrompt(null), false);
    assert.equal(isExemptPrompt(undefined), false);
    assert.equal(isExemptPrompt(123), false);
    assert.equal(isExemptPrompt({}), false);
  });

  // ---- normalizeConfig ----
  test("normalizeConfig: 空オブジェクトは既定値", () => {
    assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
  });

  test("normalizeConfig: null/非オブジェクトも既定値", () => {
    assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig("x"), DEFAULT_CONFIG);
  });

  test("normalizeConfig: 不正な mode は dry-run にフォールバック", () => {
    assert.equal(normalizeConfig({ mode: "ENFORCE" }).mode, "dry-run");
    assert.equal(normalizeConfig({ mode: "bogus" }).mode, "dry-run");
    assert.equal(normalizeConfig({ mode: 1 }).mode, "dry-run");
    // 正当な値はそのまま
    assert.equal(normalizeConfig({ mode: "enforce" }).mode, "enforce");
    assert.equal(normalizeConfig({ mode: "off" }).mode, "off");
  });

  test("normalizeConfig: 閾値の非数値は null（そのウィンドウを無視）", () => {
    const c = normalizeConfig({ thresholds: { five_hour: null, seven_day: "95" } });
    assert.equal(c.thresholds.five_hour, null);
    assert.equal(c.thresholds.seven_day, null);
  });

  test("normalizeConfig: 閾値は 0-100 にクランプ", () => {
    const c = normalizeConfig({ thresholds: { five_hour: 150, seven_day: -20 } });
    assert.equal(c.thresholds.five_hour, 100);
    assert.equal(c.thresholds.seven_day, 0);
  });

  test("normalizeConfig: 未知キーは無視する", () => {
    const c = normalizeConfig({ bogus: 1, thresholds: { unknown_window: 10 } });
    assert.ok(!Object.hasOwn(c, "bogus"));
    assert.deepEqual(Object.keys(c.thresholds).sort(), ["five_hour", "seven_day"]);
  });

  test("normalizeConfig: 数値系設定の非数値は既定値へ", () => {
    const c = normalizeConfig({ fetch_ttl_sec: "60", version_ttl_sec: null, refresh_cooldown_sec: NaN });
    assert.equal(c.fetch_ttl_sec, DEFAULT_CONFIG.fetch_ttl_sec);
    assert.equal(c.version_ttl_sec, DEFAULT_CONFIG.version_ttl_sec);
    assert.equal(c.refresh_cooldown_sec, DEFAULT_CONFIG.refresh_cooldown_sec);
  });

  test("normalizeConfig: boolean 系は指定を尊重、非 boolean は既定値", () => {
    assert.equal(normalizeConfig({ guard_subagents: false }).guard_subagents, false);
    assert.equal(normalizeConfig({ guard_subagents: "no" }).guard_subagents, true);
    assert.equal(normalizeConfig({ auto_refresh: false }).auto_refresh, false);
  });

  // ---- loadConfig ----
  test("loadConfig: config.json を読んで正規化する", () => {
    const home = mkTmp();
    const env = { HOME: home };
    writeJsonAtomic(resolveConfigPath(env), { mode: "enforce", thresholds: { five_hour: 200 } });
    const c = loadConfig(env);
    assert.equal(c.mode, "enforce");
    assert.equal(c.thresholds.five_hour, 100);
    assert.equal(c.thresholds.seven_day, DEFAULT_CONFIG.thresholds.seven_day);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("loadConfig: ファイル不在なら既定値", () => {
    const home = mkTmp();
    assert.deepEqual(loadConfig({ HOME: home }), DEFAULT_CONFIG);
    fs.rmSync(home, { recursive: true, force: true });
  });

  // ---- parseUsageResponse ----
  test("parseUsageResponse: 実測ペイロードを ISO→epoch 秒に変換する", () => {
    const w = parseUsageResponse(REAL_PAYLOAD);
    assert.equal(w.five_hour.utilization, 22.0);
    assert.equal(w.five_hour.resets_at, Math.floor(Date.parse("2026-08-20T09:39:59.874301+00:00") / 1000));
    assert.equal(w.seven_day.utilization, 21.0);
    assert.equal(w.seven_day.resets_at, Math.floor(Date.parse("2026-08-26T00:59:59.874333+00:00") / 1000));
    // 想定外キーは持ち込まない
    assert.deepEqual(Object.keys(w).sort(), ["five_hour", "seven_day"]);
  });

  test("parseUsageResponse: five_hour が null でも seven_day を返す", () => {
    const w = parseUsageResponse({ ...REAL_PAYLOAD, five_hour: null });
    assert.equal(w.five_hour, undefined);
    assert.equal(w.seven_day.utilization, 21.0);
  });

  test("parseUsageResponse: utilization が非数値のウィンドウを落とす", () => {
    const w = parseUsageResponse(
      {
        five_hour: { utilization: "22", resets_at: "2026-08-20T09:39:59Z" },
        seven_day: { utilization: true, resets_at: "2026-08-26T00:59:59Z" },
      });
    assert.equal(w, null);
  });

  test("parseUsageResponse: resets_at が不正なウィンドウを落とす", () => {
    const w = parseUsageResponse(
      {
        five_hour: { utilization: 22, resets_at: "not a date" },
        seven_day: { utilization: 21, resets_at: 1_800_000_000 },
      });
    assert.equal(w, null);
  });

  test("parseUsageResponse: 全ウィンドウ無効なら null", () => {
    assert.equal(parseUsageResponse({ five_hour: null, seven_day: null, limits: [] }), null);
    assert.equal(parseUsageResponse({}), null);
  });

  test("parseUsageResponse: object でなければ null", () => {
    assert.equal(parseUsageResponse(null), null);
    assert.equal(parseUsageResponse("x"), null);
    assert.equal(parseUsageResponse([]), null);
  });

  // ---- buildCache ----
  test("buildCache: version/fetched_at/windows を組み立てる", () => {
    const c = buildCache({ five_hour: { utilization: 1, resets_at: NOW + 60 } }, NOW);
    assert.equal(c.version, 1);
    assert.equal(c.fetched_at, NOW);
    assert.equal(c.windows.five_hour.utilization, 1);
    assert.equal(c.cc_version, undefined);
  });

  test("buildCache: prev から cc_version 系を引き継ぐ", () => {
    const c = buildCache({}, NOW, { cc_version: "2.1.266", cc_version_fetched_at: NOW - 10 });
    assert.equal(c.cc_version, "2.1.266");
    assert.equal(c.cc_version_fetched_at, NOW - 10);
  });

  // ---- parseVersionOutput / buildUserAgent ----
  test("parseVersionOutput: '2.1.266 (Claude Code)' から semver を抜く", () => {
    assert.equal(parseVersionOutput("2.1.266 (Claude Code)"), "2.1.266");
    assert.equal(parseVersionOutput("  1.0.0\n"), "1.0.0");
  });

  test("parseVersionOutput: 想定外の出力は null", () => {
    assert.equal(parseVersionOutput("unknown"), null);
    assert.equal(parseVersionOutput("2.1"), null);
    assert.equal(parseVersionOutput(""), null);
    assert.equal(parseVersionOutput(null), null);
  });

  test("buildUserAgent: claude-code/<version> 形式", () => {
    assert.equal(buildUserAgent("2.1.266"), "claude-code/2.1.266");
    assert.equal(buildUserAgent(DEFAULT_CC_VERSION), "claude-code/2.1.266");
  });

  // ---- activeWindows ----
  test("activeWindows: resets_at が未来のウィンドウだけ返す", () => {
    const cache = {
      windows: {
        five_hour: { utilization: 50, resets_at: NOW + 3_600 },
        seven_day: { utilization: 60, resets_at: NOW + 86_400 },
      },
    };
    const w = activeWindows(cache, NOW);
    assert.equal(w.length, 2);
    assert.deepEqual(w.map((x) => x.key).sort(), ["five_hour", "seven_day"]);
  });

  test("activeWindows: リセット済み（過去・同時刻）のウィンドウを落とす", () => {
    const cache = {
      windows: {
        five_hour: { utilization: 99, resets_at: NOW - 1 },
        seven_day: { utilization: 60, resets_at: NOW }, // 境界は「未来でない」ので落とす
      },
    };
    assert.deepEqual(activeWindows(cache, NOW), []);
  });

  test("activeWindows: resets_at が非数値のウィンドウを落とす（判定不能は通す側）", () => {
    const cache = {
      windows: {
        five_hour: { utilization: 99, resets_at: "2026-08-20T09:39:59Z" },
        seven_day: { utilization: 99, resets_at: null },
      },
    };
    assert.deepEqual(activeWindows(cache, NOW), []);
  });

  test("activeWindows: cache が null なら空配列", () => {
    assert.deepEqual(activeWindows(null, NOW), []);
    assert.deepEqual(activeWindows({}, NOW), []);
    assert.deepEqual(activeWindows({ windows: null }, NOW), []);
  });

  // ---- exceededWindows ----
  const win = (key, utilization) => ({ key, utilization, resets_at: NOW + 3_600 });

  test("exceededWindows: 閾値と等しければ超過扱い", () => {
    const r = exceededWindows([win("five_hour", 90)], { five_hour: 90 });
    assert.equal(r.length, 1);
    assert.equal(r[0].threshold, 90);
  });

  test("exceededWindows: 閾値未満は非超過", () => {
    assert.deepEqual(exceededWindows([win("five_hour", 89.9)], { five_hour: 90 }), []);
  });

  test("exceededWindows: 閾値 null のウィンドウは無視", () => {
    assert.deepEqual(exceededWindows([win("five_hour", 100)], { five_hour: null }), []);
    assert.deepEqual(exceededWindows([win("five_hour", 100)], {}), []);
  });

  test("exceededWindows: 超過幅の降順にソート", () => {
    const r = exceededWindows(
      [win("five_hour", 92), win("seven_day", 99)],
      { five_hour: 90, seven_day: 95 }
    );
    // five_hour は +2、seven_day は +4 → seven_day が先頭
    assert.deepEqual(r.map((x) => x.key), ["seven_day", "five_hour"]);
  });

  test("exceededWindows: 非配列入力でも例外を投げず空配列", () => {
    assert.deepEqual(exceededWindows(null, { five_hour: 90 }), []);
  });

  // ---- isBypassActive ----
  test("isBypassActive: until が未来なら true", () => {
    assert.equal(isBypassActive({ until: NOW + 1 }, NOW), true);
  });

  test("isBypassActive: until が過去・同時刻なら false", () => {
    assert.equal(isBypassActive({ until: NOW - 1 }, NOW), false);
    assert.equal(isBypassActive({ until: NOW }, NOW), false);
  });

  test("isBypassActive: until: 0 は false（解除状態）", () => {
    assert.equal(isBypassActive({ until: 0 }, NOW), false);
  });

  test("isBypassActive: null・非数値は false", () => {
    assert.equal(isBypassActive(null, NOW), false);
    assert.equal(isBypassActive({}, NOW), false);
    assert.equal(isBypassActive({ until: "later" }, NOW), false);
  });

  // ---- isTokenExpired ----
  test("isTokenExpired: ミリ秒→秒に変換して判定する", () => {
    // 1時間先に失効 → まだ有効
    assert.equal(isTokenExpired((NOW + 3_600) * 1000, NOW), false);
    // 1時間前に失効 → 失効
    assert.equal(isTokenExpired((NOW - 3_600) * 1000, NOW), true);
  });

  test("isTokenExpired: 5分マージンの境界", () => {
    // 残り 301 秒 → マージン内に入らないので有効
    assert.equal(isTokenExpired((NOW + 301) * 1000, NOW), false);
    // 残り 300 秒 → マージン境界ちょうどで失効扱い
    assert.equal(isTokenExpired((NOW + 300) * 1000, NOW), true);
    assert.equal(isTokenExpired((NOW + 299) * 1000, NOW), true);
  });

  test("isTokenExpired: マージンを明示指定できる", () => {
    assert.equal(isTokenExpired((NOW + 30) * 1000, NOW, 0), false);
    assert.equal(isTokenExpired((NOW + 30) * 1000, NOW, 60), true);
  });

  test("isTokenExpired: expiresAt 欠落・非数値は false（失効扱いにしない）", () => {
    assert.equal(isTokenExpired(undefined, NOW), false);
    assert.equal(isTokenExpired(null, NOW), false);
    assert.equal(isTokenExpired("123", NOW), false);
  });

  // ---- shouldAttemptRefresh ----
  test("shouldAttemptRefresh: クールダウン内なら false", () => {
    const r = shouldAttemptRefresh({
      cooldown: { last_attempt_at: NOW - 10 },
      nowSec: NOW,
      config: DEFAULT_CONFIG,
    });
    assert.equal(r, false);
  });

  test("shouldAttemptRefresh: クールダウン経過なら true", () => {
    const r = shouldAttemptRefresh({
      cooldown: { last_attempt_at: NOW - DEFAULT_CONFIG.refresh_cooldown_sec },
      nowSec: NOW,
      config: DEFAULT_CONFIG,
    });
    assert.equal(r, true);
  });

  test("shouldAttemptRefresh: 記録なしなら true", () => {
    assert.equal(shouldAttemptRefresh({ cooldown: null, nowSec: NOW, config: DEFAULT_CONFIG }), true);
    assert.equal(shouldAttemptRefresh({ cooldown: {}, nowSec: NOW, config: DEFAULT_CONFIG }), true);
  });

  test("shouldAttemptRefresh: auto_refresh: false なら常に false", () => {
    const config = { ...DEFAULT_CONFIG, auto_refresh: false };
    assert.equal(shouldAttemptRefresh({ cooldown: null, nowSec: NOW, config }), false);
  });

  // ---- evaluate ----
  const cacheWith = (fiveHourUtil, sevenDayUtil = 0) => ({
    version: 1,
    fetched_at: NOW,
    windows: {
      five_hour: { utilization: fiveHourUtil, resets_at: NOW + 3_600 },
      seven_day: { utilization: sevenDayUtil, resets_at: NOW + 86_400 },
    },
  });

  test("evaluate: 未超過なら allow", () => {
    const r = evaluate({ cache: cacheWith(50), config: DEFAULT_CONFIG, bypass: null, nowSec: NOW });
    assert.equal(r.action, "allow");
    assert.deepEqual(r.exceeded, []);
  });

  test("evaluate: dry-run で超過なら warn", () => {
    const r = evaluate({ cache: cacheWith(95), config: DEFAULT_CONFIG, bypass: null, nowSec: NOW });
    assert.equal(r.action, "warn");
    assert.equal(r.exceeded.length, 1);
    assert.ok(r.reason.length > 0);
  });

  test("evaluate: enforce で超過なら block", () => {
    const config = { ...DEFAULT_CONFIG, mode: "enforce" };
    const r = evaluate({ cache: cacheWith(95), config, bypass: null, nowSec: NOW });
    assert.equal(r.action, "block");
    assert.equal(r.exceeded[0].key, "five_hour");
  });

  test("evaluate: mode: off なら超過していても allow", () => {
    const config = { ...DEFAULT_CONFIG, mode: "off" };
    const r = evaluate({ cache: cacheWith(100, 100), config, bypass: null, nowSec: NOW });
    assert.equal(r.action, "allow");
  });

  test("evaluate: バイパス中は超過していても allow", () => {
    const config = { ...DEFAULT_CONFIG, mode: "enforce" };
    const r = evaluate({
      cache: cacheWith(100),
      config,
      bypass: { until: NOW + 600 },
      nowSec: NOW,
    });
    assert.equal(r.action, "allow");
  });

  test("evaluate: cache が null なら allow（fail-open）", () => {
    const config = { ...DEFAULT_CONFIG, mode: "enforce" };
    const r = evaluate({ cache: null, config, bypass: null, nowSec: NOW });
    assert.equal(r.action, "allow");
    assert.deepEqual(r.windows, []);
  });

  test("evaluate: 全ウィンドウがリセット済みなら allow", () => {
    const config = { ...DEFAULT_CONFIG, mode: "enforce" };
    const cache = {
      windows: {
        five_hour: { utilization: 100, resets_at: NOW - 1 },
        seven_day: { utilization: 100, resets_at: NOW - 1 },
      },
    };
    assert.equal(evaluate({ cache, config, bypass: null, nowSec: NOW }).action, "allow");
  });

  test("evaluate: guard_subagents: true ならサブエージェントもブロック", () => {
    const config = { ...DEFAULT_CONFIG, mode: "enforce", guard_subagents: true };
    const r = evaluate({
      cache: cacheWith(95),
      config,
      bypass: null,
      nowSec: NOW,
      agentType: "Explore",
    });
    assert.equal(r.action, "block");
  });

  test("evaluate: guard_subagents: false ならサブエージェントは allow", () => {
    const config = { ...DEFAULT_CONFIG, mode: "enforce", guard_subagents: false };
    const r = evaluate({
      cache: cacheWith(95),
      config,
      bypass: null,
      nowSec: NOW,
      agentType: "Explore",
    });
    assert.equal(r.action, "allow");
    // agentType が無い（メイン）なら guard_subagents: false でもブロックされる
    assert.equal(evaluate({ cache: cacheWith(95), config, bypass: null, nowSec: NOW }).action, "block");
  });

  // ---- buildOutput ----
  const blockEval = { action: "block", reason: "REASON_MARKER", exceeded: [], windows: [] };
  const warnEval = { action: "warn", reason: "REASON_MARKER", exceeded: [], windows: [] };
  const allowEval = { action: "allow", reason: "", exceeded: [], windows: [] };

  test("buildOutput: UserPromptSubmit × block は decision: block", () => {
    const o = buildOutput(blockEval, "UserPromptSubmit");
    assert.equal(o.decision, "block");
    assert.equal(o.reason, "REASON_MARKER");
  });

  test("buildOutput: UserPromptSubmit × warn は systemMessage のみ（additionalContext を含まない）", () => {
    const o = buildOutput(warnEval, "UserPromptSubmit");
    assert.ok(o.systemMessage.includes("[usage-guard dry-run]"));
    assert.ok(o.systemMessage.includes("REASON_MARKER"));
    assert.ok(!Object.hasOwn(o, "additionalContext"));
    assert.ok(!Object.hasOwn(o, "decision"));
    assert.deepEqual(Object.keys(o), ["systemMessage"]);
  });

  test("buildOutput: PostToolBatch × block は continue:false + stopReason", () => {
    const o = buildOutput(blockEval, "PostToolBatch");
    assert.equal(o.continue, false);
    assert.equal(o.stopReason, "REASON_MARKER");
  });

  test("buildOutput: PostToolBatch × warn は null（毎バッチ通知のスパムを避ける）", () => {
    assert.equal(buildOutput(warnEval, "PostToolBatch"), null);
  });

  test("buildOutput: allow は常に null", () => {
    assert.equal(buildOutput(allowEval, "UserPromptSubmit"), null);
    assert.equal(buildOutput(allowEval, "PostToolBatch"), null);
    assert.equal(buildOutput(null, "UserPromptSubmit"), null);
  });

  test("buildOutput: 未対応イベントは null", () => {
    assert.equal(buildOutput(blockEval, "SessionStart"), null);
    assert.equal(buildOutput(warnEval, undefined), null);
  });

  // ---- formatReason ----
  test("formatReason: 超過ウィンドウの utilization と閾値を含む", () => {
    const r = formatReason({
      exceeded: [{ key: "five_hour", utilization: 95.5, resets_at: NOW + 3_600, threshold: 90 }],
      windows: [],
      config: DEFAULT_CONFIG,
      nowSec: NOW,
    });
    assert.ok(r.includes("5時間枠"));
    assert.ok(r.includes("95.5%"));
    assert.ok(r.includes("90%"));
  });

  test("formatReason: リセット時刻（絶対＋相対）を含む", () => {
    const r = formatReason({
      exceeded: [{ key: "five_hour", utilization: 95, resets_at: NOW + 5_040, threshold: 90 }],
      windows: [],
      config: DEFAULT_CONFIG,
      nowSec: NOW,
    });
    assert.ok(r.includes("あと1時間24分"));
    assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r));
  });

  test("formatReason: バイパスコマンド文字列を含む", () => {
    const r = formatReason({
      exceeded: [{ key: "five_hour", utilization: 95, resets_at: NOW + 60, threshold: 90 }],
      windows: [],
      config: DEFAULT_CONFIG,
      nowSec: NOW,
    });
    assert.ok(r.includes("/usage-guard:usage-guard-bypass 30m"));
  });

  test("formatReason: 未超過ウィンドウの utilization も併記する", () => {
    const five = { key: "five_hour", utilization: 95, resets_at: NOW + 60, threshold: 90 };
    const seven = { key: "seven_day", utilization: 12, resets_at: NOW + 86_400 };
    const r = formatReason({
      exceeded: [five],
      windows: [{ key: "five_hour", utilization: 95, resets_at: NOW + 60 }, seven],
      config: DEFAULT_CONFIG,
      nowSec: NOW,
    });
    assert.ok(r.includes("未超過のウィンドウ"));
    assert.ok(r.includes("週次枠"));
    assert.ok(r.includes("12%"));
  });

  test("formatReason: mode と config パスを含む", () => {
    const r = formatReason({
      exceeded: [{ key: "five_hour", utilization: 95, resets_at: NOW + 60, threshold: 90 }],
      windows: [],
      config: { ...DEFAULT_CONFIG, mode: "enforce" },
      nowSec: NOW,
      configPath: "/home/u/.claude/usage-guard/config.json",
    });
    assert.ok(r.includes("enforce"));
    assert.ok(r.includes("/home/u/.claude/usage-guard/config.json"));
  });

  test("formatReason: agentType があれば併記する", () => {
    const r = formatReason({
      exceeded: [{ key: "five_hour", utilization: 95, resets_at: NOW + 60, threshold: 90 }],
      windows: [],
      config: DEFAULT_CONFIG,
      nowSec: NOW,
      agentType: "Explore",
    });
    assert.ok(r.includes("Explore"));
  });

  // ---- formatDuration ----
  test("formatDuration: 1時間以上は時間と分に分解する", () => {
    assert.equal(formatDuration(5_040), "1時間24分"); // 1h24m
    assert.equal(formatDuration(3_600), "1時間0分");
  });

  test("formatDuration: 1時間未満は分のみ", () => {
    assert.equal(formatDuration(180), "3分");
    assert.equal(formatDuration(59), "0分");
  });

  test("formatDuration: 24時間以上は日と時間", () => {
    assert.equal(formatDuration(6 * 86_400 + 23 * 3_600), "6日23時間");
    assert.equal(formatDuration(86_400), "1日0時間");
  });

  test("formatDuration: 0以下・非数値は 0分", () => {
    assert.equal(formatDuration(0), "0分");
    assert.equal(formatDuration(-100), "0分");
    assert.equal(formatDuration(null), "0分");
    assert.equal(formatDuration(NaN), "0分");
  });

  // ---- formatResetAt ----
  test("formatResetAt: 絶対時刻と相対時間を併記する", () => {
    const target = NOW + 5_040;
    const s = formatResetAt(target, NOW);
    const d = new Date(target * 1000);
    const expectedAbs = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    assert.equal(s, `${expectedAbs} (あと1時間24分)`);
  });

  test("formatResetAt: 過去の時刻でも (あと0分) で壊れない", () => {
    assert.ok(formatResetAt(NOW - 100, NOW).endsWith("(あと0分)"));
  });

  // ---- parseDuration ----
  test("parseDuration: '30m' は30分後", () => {
    const r = parseDuration("30m", null, NOW);
    assert.equal(r.until, NOW + 1_800);
    assert.equal(r.label, "30m");
  });

  test("parseDuration: '2h' は2時間後", () => {
    assert.equal(parseDuration("2h", null, NOW).until, NOW + 7_200);
  });

  test("parseDuration: 単位なし '90' は90分後", () => {
    const r = parseDuration("90", null, NOW);
    assert.equal(r.until, NOW + 5_400);
    assert.equal(r.label, "90m");
  });

  test("parseDuration: 'reset' は5時間枠のリセット時刻", () => {
    const cache = { windows: { five_hour: { utilization: 99, resets_at: NOW + 1_234 } } };
    const r = parseDuration("reset", cache, NOW);
    assert.equal(r.until, NOW + 1_234);
    assert.equal(r.label, "reset");
  });

  test("parseDuration: 'reset' で cache が無ければ null", () => {
    assert.equal(parseDuration("reset", null, NOW), null);
    assert.equal(parseDuration("reset", { windows: {} }, NOW), null);
    assert.equal(parseDuration("reset", { windows: { five_hour: {} } }, NOW), null);
  });

  test("parseDuration: 'off' は until 0（即時解除）", () => {
    const r = parseDuration("off", null, NOW);
    assert.equal(r.until, 0);
    assert.equal(r.label, "off");
    assert.equal(isBypassActive(r, NOW), false);
  });

  test("parseDuration: 不正な入力は null", () => {
    assert.equal(parseDuration("abc", null, NOW), null);
    assert.equal(parseDuration("30d", null, NOW), null);
    assert.equal(parseDuration("-5m", null, NOW), null);
    assert.equal(parseDuration("0m", null, NOW), null);
  });

  test("parseDuration: 未指定（null/undefined/空文字）は30分", () => {
    assert.equal(parseDuration(null, null, NOW).until, NOW + 1_800);
    assert.equal(parseDuration(undefined, null, NOW).until, NOW + 1_800);
    assert.equal(parseDuration("", null, NOW).until, NOW + 1_800);
    assert.equal(parseDuration("   ", null, NOW).until, NOW + 1_800);
  });

  // ---- writeJsonAtomic / readJson ----
  test("writeJsonAtomic + readJson: ラウンドトリップ", () => {
    const dir = mkTmp();
    const file = path.join(dir, "cache.json");
    const obj = { version: 1, windows: { five_hour: { utilization: 22, resets_at: NOW } } };
    assert.equal(writeJsonAtomic(file, obj), true);
    assert.deepEqual(readJson(file), obj);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writeJsonAtomic: 親ディレクトリを再帰的に作る", () => {
    const dir = mkTmp();
    const file = path.join(dir, "a", "b", "c.json");
    assert.equal(writeJsonAtomic(file, { ok: true }), true);
    assert.deepEqual(readJson(file), { ok: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writeJsonAtomic: 完了後に .tmp ファイルが残らない", () => {
    const dir = mkTmp();
    const file = path.join(dir, "cache.json");
    writeJsonAtomic(file, { ok: true });
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writeJsonAtomic: 書き込み不能パスでも例外を投げず false", () => {
    const dir = mkTmp();
    // ファイルをディレクトリとして扱わせて mkdirSync を失敗させる
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x");
    assert.equal(writeJsonAtomic(path.join(blocker, "sub", "c.json"), { ok: true }), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("readJson: ファイル不在は null", () => {
    assert.equal(readJson(path.join(os.tmpdir(), `usage-guard-missing-${process.pid}.json`)), null);
  });

  test("readJson: 壊れた JSON は null", () => {
    const dir = mkTmp();
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{not json");
    assert.equal(readJson(file), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("readJson: JSON だがオブジェクトでない場合も null", () => {
    const dir = mkTmp();
    const file = path.join(dir, "scalar.json");
    fs.writeFileSync(file, "42");
    assert.equal(readJson(file), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- appendLogLine ----
  test("appendLogLine: JSONL を追記し、失敗しても例外を投げない", () => {
    const dir = mkTmp();
    const file = path.join(dir, "nested", "usage.log");
    appendLogLine(file, { a: 1 });
    appendLogLine(file, { a: 2 });
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    assert.deepEqual(lines.map((l) => JSON.parse(l).a), [1, 2]);
    // 書けないパスでも throw しない
    appendLogLine("/proc/definitely/not/writable/x.log", { a: 3 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- createLogger / resolveDebugLogPath ----
  test("resolveDebugLogPath: 既定(未設定)は null", () => {
    assert.equal(resolveDebugLogPath({}), null);
  });

  test("resolveDebugLogPath: 有効時は temp ディレクトリ、FILE 指定を優先", () => {
    const p = resolveDebugLogPath({ USAGE_GUARD_DEBUG: "1" });
    assert.ok(p.startsWith(os.tmpdir()));
    assert.ok(p.endsWith("usage-guard-debug.log"));
    assert.equal(
      resolveDebugLogPath({ USAGE_GUARD_DEBUG: "1", USAGE_GUARD_DEBUG_FILE: "/var/log/ug.log" }),
      "/var/log/ug.log"
    );
  });

  test("createLogger: DEBUG 未設定なら no-op（ファイルを作らない）", () => {
    const dir = mkTmp();
    const file = path.join(dir, "debug.log");
    createLogger({ USAGE_GUARD_DEBUG_FILE: file })("x");
    assert.equal(fs.existsSync(file), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("createLogger: DEBUG 設定時は指定ファイルに追記する", () => {
    const dir = mkTmp();
    const file = path.join(dir, "debug.log");
    const log = createLogger({ USAGE_GUARD_DEBUG: "1", USAGE_GUARD_DEBUG_FILE: file });
    log("line1");
    assert.equal(fs.readFileSync(file, "utf-8"), "line1\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
