#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// mo の名前付きグループ（--target）末尾セグメントの既定値。<project>/<suffix> の suffix 側。
export const DEFAULT_TARGET_SUFFIX = "plans";
// transcript の先頭からこの行数までを走査して planFilePath を探す（plan_mode attachment は先頭付近に出る）。
export const MAX_TRANSCRIPT_LINES = 200;

// planFilePath（.../<project>/.claude/plans/xxx.md）から <project>（プロジェクトのルートディレクトリ名）を導出する。
// 期待する構造でない場合は空文字を返す（呼び出し側で suffix のみにフォールバック）。
export function deriveProjectName(planFilePath) {
  if (typeof planFilePath !== "string" || !planFilePath) return "";
  const plansDir = path.dirname(planFilePath); // .../.claude/plans
  const claudeDir = path.dirname(plansDir); // .../.claude
  const projectRoot = path.dirname(claudeDir); // .../<project>
  const name = path.basename(projectRoot);
  // 導出が破綻しているケース（"." や "/" など）は空文字扱い
  if (!name || name === "." || name === path.sep) return "";
  return name;
}

// mo に渡す --target グループ名を決める。
// プロジェクト名が導出できれば `<project>/<suffix>`、できなければ `<suffix>` のみ。
// suffix は PLAN_WORKFLOW_TARGET が指定されていればそれを優先、未指定なら DEFAULT_TARGET_SUFFIX。
export function resolveTarget(planFilePath, env = {}) {
  const override = env.PLAN_WORKFLOW_TARGET;
  const suffix = override && override.trim() ? override.trim() : DEFAULT_TARGET_SUFFIX;
  const project = deriveProjectName(planFilePath);
  return project ? `${project}/${suffix}` : suffix;
}

// transcript（JSONL文字列）を走査し、plan_mode attachment の planFilePath を返す。
// 見つからなければ null。壊れた行はスキップする。
// plan-archive プラグインの resolvePlansDir と同じレコード構造に依存:
//   { type: "attachment", attachment: { type: "plan_mode", planFilePath: "/abs/.../xxx.md" } }
export function resolvePlanFilePath(transcriptText) {
  if (typeof transcriptText !== "string" || !transcriptText) return null;
  const lines = transcriptText.split("\n");
  const limit = Math.min(lines.length, MAX_TRANSCRIPT_LINES);
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (!line.includes('"planFilePath"')) continue;
    try {
      const entry = JSON.parse(line);
      const planFilePath =
        entry?.attachment?.type === "plan_mode" ? entry.attachment.planFilePath : undefined;
      if (planFilePath && typeof planFilePath === "string") {
        return planFilePath;
      }
    } catch {
      // 壊れた行はスキップ
    }
  }
  return null;
}

// デバッグログの書き出し先を決める。既定（PLAN_WORKFLOW_DEBUG 未設定）は null＝ログ無効。
export function resolveDebugLogPath(env = {}) {
  if (!env.PLAN_WORKFLOW_DEBUG) return null;
  const override = env.PLAN_WORKFLOW_DEBUG_FILE;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.tmpdir(), "plan-workflow-debug.log");
}

// デバッグログ用の log 関数を作る。resolveDebugLogPath が null を返す（未設定）ときは何もしない no-op。
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
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  test("deriveProjectName: .claude/plans の親からプロジェクト名を導出", () => {
    assert.equal(
      deriveProjectName("/Users/aki/src/github.com/SonicGarden/social-apartment/.claude/plans/x.md"),
      "social-apartment"
    );
  });

  test("deriveProjectName: 期待構造（.claude/plans）でないパスは空文字", () => {
    // /tmp/plans/bar.md は .claude を挟まないため 3 階層上が "/" になり basename は空
    assert.equal(deriveProjectName("/tmp/plans/bar.md"), "");
    // 相対パス x.md は導出が "." に落ちるので空文字扱い
    assert.equal(deriveProjectName("x.md"), "");
  });

  test("deriveProjectName: 非文字列・空は空文字", () => {
    assert.equal(deriveProjectName(null), "");
    assert.equal(deriveProjectName(""), "");
  });

  test("resolveTarget: プロジェクト名が導出できれば <project>/plans", () => {
    const p = "/Users/aki/src/github.com/SonicGarden/social-apartment/.claude/plans/x.md";
    assert.equal(resolveTarget(p, {}), "social-apartment/plans");
  });

  test("resolveTarget: PLAN_WORKFLOW_TARGET で suffix を上書き", () => {
    const p = "/abs/proj/.claude/plans/x.md";
    assert.equal(resolveTarget(p, { PLAN_WORKFLOW_TARGET: "design" }), "proj/design");
  });

  test("resolveTarget: 空文字・空白の suffix は既定 plans にフォールバック", () => {
    const p = "/abs/proj/.claude/plans/x.md";
    assert.equal(resolveTarget(p, { PLAN_WORKFLOW_TARGET: "" }), "proj/plans");
    assert.equal(resolveTarget(p, { PLAN_WORKFLOW_TARGET: "   " }), "proj/plans");
  });

  test("resolveTarget: プロジェクト名が導出できないときは suffix のみ", () => {
    assert.equal(resolveTarget("x.md", {}), "plans");
    assert.equal(resolveTarget(null, { PLAN_WORKFLOW_TARGET: "design" }), "design");
  });

  test("resolvePlanFilePath: plan_mode attachment から planFilePath を取り出す", () => {
    const line = JSON.stringify({
      type: "attachment",
      attachment: { type: "plan_mode", planFilePath: "/abs/.claude/plans/foo.md" },
    });
    assert.equal(resolvePlanFilePath(line), "/abs/.claude/plans/foo.md");
  });

  test("resolvePlanFilePath: 複数行のうち最初に見つかった planFilePath を返す", () => {
    const l1 = JSON.stringify({ type: "user", message: "hi" });
    const l2 = JSON.stringify({
      type: "attachment",
      attachment: { type: "plan_mode", planFilePath: "/abs/first.md" },
    });
    const l3 = JSON.stringify({
      type: "attachment",
      attachment: { type: "plan_mode", planFilePath: "/abs/second.md" },
    });
    assert.equal(resolvePlanFilePath([l1, l2, l3].join("\n")), "/abs/first.md");
  });

  test("resolvePlanFilePath: attachment.type が plan_mode 以外なら無視", () => {
    const line = JSON.stringify({
      type: "attachment",
      attachment: { type: "image", planFilePath: "/abs/nope.md" },
    });
    assert.equal(resolvePlanFilePath(line), null);
  });

  test("resolvePlanFilePath: planFilePath を含まない transcript は null", () => {
    const line = JSON.stringify({ type: "user", message: "no plan here" });
    assert.equal(resolvePlanFilePath(line), null);
  });

  test("resolvePlanFilePath: 壊れた行はスキップして後続から探す", () => {
    const broken = '{"planFilePath": broken json';
    const ok = JSON.stringify({
      type: "attachment",
      attachment: { type: "plan_mode", planFilePath: "/abs/ok.md" },
    });
    assert.equal(resolvePlanFilePath([broken, ok].join("\n")), "/abs/ok.md");
  });

  test("resolvePlanFilePath: 非文字列・空文字列は null", () => {
    assert.equal(resolvePlanFilePath(null), null);
    assert.equal(resolvePlanFilePath(""), null);
    assert.equal(resolvePlanFilePath(undefined), null);
  });

  test("resolveDebugLogPath: 既定(未設定)は null", () => {
    assert.equal(resolveDebugLogPath({}), null);
  });

  test("resolveDebugLogPath: 有効時は temp ディレクトリ", () => {
    const p = resolveDebugLogPath({ PLAN_WORKFLOW_DEBUG: "1" });
    assert.ok(p.startsWith(os.tmpdir()));
    assert.ok(p.endsWith("plan-workflow-debug.log"));
  });

  test("resolveDebugLogPath: DEBUG_FILE 指定を優先", () => {
    assert.equal(
      resolveDebugLogPath({ PLAN_WORKFLOW_DEBUG: "1", PLAN_WORKFLOW_DEBUG_FILE: "/var/log/p.log" }),
      "/var/log/p.log"
    );
  });
}
