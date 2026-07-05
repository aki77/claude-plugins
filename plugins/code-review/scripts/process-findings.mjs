#!/usr/bin/env node
// レビューエージェント（ステップ3）の finding 配列を機械処理して FINDINGS 成果物にする中核。
//
// 設計原則（alibaba/open-code-review 由来）: **LLM は意味判断のみ、位置解決・検証・
// フィルタ適用・構造転写はコード**。ステップ3のエージェントは「diff に実在する連続コード片
// （existingCode アンカー）」付きの finding を JSON で出すだけ。このスクリプトが以下を
// すべて機械的に行い、実行ごとのブレ・黙殺・転記ミスを排除する:
//   1. ID 付与（入力順 f1..fN）
//   2. スキーマ検証（違反は finding 単位で status:"invalid"。全体は落とさない）
//   3. スコープ機械チェック（path ∉ changedFiles / ∈ excludedFiles → status:"out-of-scope"）
//   4. kind 導出（agent 3,4 → bug / 1,2,5 → rule。LLM に書かせない）
//   5. アンカー解決（lib/diff-anchor の resolveAnchor で行番号を確定）
//   6. 機械グルーピング（旧ステップ4「重複統合」の機械化。行範囲の重なり / 同一アンカー）
//
// 入力:
//   引数 --context <CTX>            : collect-review-context.mjs の CTX ファイルパス。
//                                     ここから diffArgs/excludeArgs を読み、同一 diff を再生成する。
//   引数 --retry <前回FINDINGSパス>  : 未解決 finding のアンカーを LLM が修正したパッチを
//                                     stdin で受け、該当のみ再解決して全体を再グルーピングする。
//   stdin（初回）: finding 配列。**配列の配列も受理し自動フラット化**（メインエージェントは
//                  各エージェントの fenced JSON をそのまま並べるだけでよい）。
//   stdin（--retry）: [{ "id": "f3", "existingCode": "修正後アンカー" }] のパッチ配列。
// 出力(stdout): FINDINGS 成果物ファイルのパス（1行）。中身は
//   { findings[], groups[], stats:{total, valid, invalid, outOfScope, resolved, unresolved, groups, multiGroups} }
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fail, parseFlags, readArtifact, readInputJsonList, writeArtifact } from "./lib/artifact.mjs";
import { buildDiffArgs, parseDiff, resolveAnchor, splitAndNormalize } from "./lib/diff-anchor.mjs";

// ---- スキーマ検証 ------------------------------------------------------------
// finding 1 件のスキーマを検証し、違反理由の配列を返す（空なら valid）。
// 必須: agent∈1..5 / path / title / body / existingCode。ruleRefs は agent 1,2,5 で必須、
// 3,4 では省略可（後段で [] 補完）。
const RULE_AGENTS = new Set([1, 2, 5]);

function validateFinding(f) {
  const errors = [];
  if (!f || typeof f !== "object" || Array.isArray(f)) {
    return ["finding がオブジェクトでない"];
  }
  if (!Number.isInteger(f.agent) || f.agent < 1 || f.agent > 5) {
    errors.push("agent は 1..5 の整数である必要がある");
  }
  for (const key of ["path", "title", "body", "existingCode"]) {
    if (typeof f[key] !== "string" || f[key].trim() === "") {
      errors.push(`${key} は非空文字列である必要がある`);
    }
  }
  if (RULE_AGENTS.has(f.agent)) {
    if (!Array.isArray(f.ruleRefs) || f.ruleRefs.length === 0) {
      errors.push("agent 1/2/5 は ruleRefs（非空配列）が必須");
    }
  }
  return errors;
}

// agent 種別から kind を導出する（LLM に書かせない機械適用）。
function deriveKind(agent) {
  return agent === 3 || agent === 4 ? "bug" : "rule";
}

// finding にアンカー解決結果を書き込む（初回・--retry 共通）。resolved:true なら
// params をセットし reason を消す、resolved:false なら reason をセットし params を消す
// （params/reason の相互排他をここ1か所で担保する）。finding を破壊的に更新して返す。
function applyAnchor(finding, filesByPath) {
  const r = resolveAnchor(finding, filesByPath);
  if (r.resolved) {
    finding.resolved = true;
    finding.params = r.params;
    delete finding.reason;
  } else {
    finding.resolved = false;
    finding.reason = r.reason;
    delete finding.params;
  }
  return finding;
}

// ---- 機械グルーピング --------------------------------------------------------
// union-find（素集合）。行範囲の重なりでの推移的連結に使う。
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); // 小さい index を根に寄せる（安定性）
  };
  return { find, union };
}

// resolved:true の finding の params から [startLine, endLine] を取り出す。
function lineRange(params) {
  const end = params.line;
  const start = params.startLine ?? end;
  return [Math.min(start, end), Math.max(start, end)];
}

// 2 つの行範囲が1行以上重なるか。
function rangesOverlap(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

// 合成範囲（グループ全体をカバーする最小の startLine..line）と params を組み立てる。
// side/startSide はグループ内で同一（同一 path+side でしかグルーピングしないため先頭を採用）。
function mergeParams(members) {
  let min = Infinity;
  let max = -Infinity;
  for (const m of members) {
    const [s, e] = lineRange(m.params);
    if (s < min) min = s;
    if (e > max) max = e;
  }
  const side = members[0].params.side;
  if (min === max) {
    return { line: max, side, subjectType: "LINE" };
  }
  return {
    startLine: min,
    line: max,
    startSide: side,
    side,
    subjectType: "LINE",
  };
}

// findings を機械グルーピングする。戻り値は groups[]（各グループは members の id 配列と
// 合成 params / kind / needsMergeText を持つ）。
//   - 解決済み: 同一 path + side で行範囲が1行以上重なるものを union-find で推移的に連結
//   - 未解決:   同一 path + 正規化 existingCode 完全一致のみ同グループ
//   - kind:     グループ内に bug が1件でもあれば bug（由来種別優先の機械適用）
//   - members 2件以上 → needsMergeText:true（統合文章を LLM に作らせる対象）
function groupFindings(findings) {
  // グルーピング対象は valid かつ in-scope な finding のみ（invalid/out-of-scope は単独扱いしない）。
  const active = findings.filter((f) => f.status === "active");

  // --- 解決済み: path+side ごとに行範囲重なりで union-find 連結 ---
  const resolved = active.filter((f) => f.resolved);
  const bySideKey = new Map(); // `${path}\0${side}` -> indices(resolved 配列内)
  resolved.forEach((f, i) => {
    const key = `${f.path}\0${f.params.side}`;
    if (!bySideKey.has(key)) bySideKey.set(key, []);
    bySideKey.get(key).push(i);
  });
  const uf = makeUnionFind(resolved.length);
  for (const idxs of bySideKey.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const ra = lineRange(resolved[idxs[a]].params);
        const rb = lineRange(resolved[idxs[b]].params);
        if (rangesOverlap(ra, rb)) uf.union(idxs[a], idxs[b]);
      }
    }
  }
  // root -> members。Map は挿入順を保つため、root が最初に現れた順＝入力順で並ぶ
  // （後続のグループ採番もこの順を使う）。
  const resolvedGroups = new Map();
  resolved.forEach((f, i) => {
    const root = uf.find(i);
    if (!resolvedGroups.has(root)) resolvedGroups.set(root, []);
    resolvedGroups.get(root).push(f);
  });

  // --- 未解決: path + 正規化 existingCode 完全一致のみ同グループ ---
  const unresolved = active.filter((f) => !f.resolved);
  const unresolvedGroups = new Map(); // key -> finding 配列
  for (const f of unresolved) {
    const key = `${f.path}\0${splitAndNormalize(f.existingCode).join("\n")}`;
    if (!unresolvedGroups.has(key)) unresolvedGroups.set(key, []);
    unresolvedGroups.get(key).push(f);
  }

  // --- グループ構造の組み立て（安定した順序で gN を採番）---
  const groups = [];
  const buildGroup = (members, { resolved }) => {
    const kind = members.some((m) => m.kind === "bug") ? "bug" : "rule";
    const g = {
      id: `g${groups.length + 1}`,
      path: members[0].path,
      kind,
      resolved,
      memberIds: members.map((m) => m.id),
      needsMergeText: members.length >= 2,
    };
    if (resolved) {
      g.params = mergeParams(members);
    } else {
      // 未解決グループは params を持たない。アンカー（先頭 finding の existingCode）は
      // merge-findings が転写する。
      g.reason = members[0].reason;
    }
    groups.push(g);
    // 各 finding に所属グループ id を刻む（成果物の追跡用）。
    for (const m of members) m.groupId = g.id;
  };

  // resolvedGroups は root 初出順（＝入力順）なので、そのまま採番していけばよい。
  for (const members of resolvedGroups.values()) {
    buildGroup(members, { resolved: true });
  }
  for (const members of unresolvedGroups.values()) {
    buildGroup(members, { resolved: false });
  }

  return groups;
}

// ---- 中核純粋関数 ------------------------------------------------------------
// rawInput: finding 配列（配列の配列も可）／--retry 時は前回 findings に prev として渡す
//   のではなく、rawInput をパッチ配列として扱う（下記 prev 分岐）。
// ctx: CTX オブジェクト（changedFiles / excludedFiles / diffArgs / excludeArgs）
// diffText: buildDiffArgs で取得済みの統一 diff テキスト
// prev: --retry 時のみ、前回 FINDINGS 成果物オブジェクト（findings を持つ）
//
// 戻り値: { findings, groups, stats }
export function processFindings(rawInput, { ctx, diffText, prev = null }) {
  const changedSet = new Set(ctx.changedFiles ?? []);
  const excludedSet = new Set(ctx.excludedFiles ?? []);
  const filesByPath = parseDiff(diffText);

  let findings;
  if (prev) {
    // --retry: rawInput は [{id, existingCode}] のパッチ配列。前回 findings をベースに、
    // 該当 id の existingCode を差し替え、再解決対象（active かつ未解決だったもの）だけ
    // アンカー解決をやり直す。パッチに無い finding はそのまま維持する。
    if (!Array.isArray(rawInput)) {
      throw new Error("--retry の stdin は [{id, existingCode}] の配列である必要があります");
    }
    const patchById = new Map();
    for (const p of rawInput) {
      if (p && typeof p.id === "string") patchById.set(p.id, p.existingCode);
    }
    findings = prev.findings.map((f) => {
      // groupId は再グルーピングで振り直すため一旦落とす。
      const { groupId, ...rest } = f;
      const patched = { ...rest };
      if (patchById.has(f.id) && typeof patchById.get(f.id) === "string") {
        patched.existingCode = patchById.get(f.id);
      }
      // active かつ未解決だったものだけ再解決する（invalid/out-of-scope/解決済みは触らない）。
      if (patched.status === "active" && !patched.resolved) {
        applyAnchor(patched, filesByPath);
      }
      return patched;
    });
  } else {
    // 初回: 配列の配列を自動フラット化してから処理する。
    const flat = Array.isArray(rawInput) ? rawInput.flat() : null;
    if (!Array.isArray(flat)) {
      throw new Error("stdin は finding 配列（または配列の配列）である必要があります");
    }
    findings = flat.map((raw, i) => {
      const id = `f${i + 1}`;
      const errors = validateFinding(raw);
      if (errors.length > 0) {
        // 不正 finding も落とさず携行する（全体は止めない）。位置解決・グルーピングの対象外。
        return {
          id,
          agent: raw?.agent,
          path: raw?.path,
          title: raw?.title,
          status: "invalid",
          errors,
        };
      }
      // ruleRefs: agent 1/2/5 は検証済みで非空配列、3/4 は省略可なので [] 補完（両者とも
      // `?? []` で足りる。検証を通っている以上 agent 1/2/5 で null になることはない）。
      const base = {
        id,
        agent: raw.agent,
        path: raw.path,
        title: raw.title,
        body: raw.body,
        existingCode: raw.existingCode,
        ruleRefs: raw.ruleRefs ?? [],
        kind: deriveKind(raw.agent),
      };
      // スコープ機械チェック: diff 対象外ファイルへの指摘を機械的に弾く。
      if (!changedSet.has(raw.path) || excludedSet.has(raw.path)) {
        return { ...base, status: "out-of-scope" };
      }
      // アンカー解決（初回・--retry 共通の applyAnchor で params/reason を確定）。
      return applyAnchor({ ...base, status: "active" }, filesByPath);
    });
  }

  const groups = groupFindings(findings);

  const stats = {
    total: findings.length,
    valid: findings.filter((f) => f.status === "active").length,
    invalid: findings.filter((f) => f.status === "invalid").length,
    outOfScope: findings.filter((f) => f.status === "out-of-scope").length,
    resolved: findings.filter((f) => f.status === "active" && f.resolved).length,
    unresolved: findings.filter((f) => f.status === "active" && !f.resolved).length,
    groups: groups.length,
    multiGroups: groups.filter((g) => g.needsMergeText).length,
  };

  return { findings, groups, stats };
}

// ---- main --------------------------------------------------------------------
if (!process.env.NODE_TEST_CONTEXT) {
  const { context, retry, infile } = parseFlags(process.argv, {
    flags: ["--context", "--retry", "--infile"],
    required: ["--context"],
    multi: ["--infile"],
    usage:
      "process-findings.mjs --context <CTX> [--retry <前回FINDINGS>] --infile <a.json> [--infile <b.json> ...]  (--infile 省略時は stdin)",
  });

  // 入力の階層を processFindings が期待する形に均す。
  //   初回の --infile 集約時のみ「配列の配列（各エージェントの finding 配列を要素とする
  //     配列）」を渡し、processFindings が1段フラット化する（readInputJsonList の戻り
  //     [[f...],[f...]] がまさにその形）。
  //   それ以外は単一 JSON を渡す: --retry は単一パッチ配列 [{id, existingCode}]、
  //     stdin fallback は「配列の配列」1本が [stdin値] に包まれるので、いずれも先頭を取る。
  let rawInput;
  try {
    const inputs = readInputJsonList(infile);
    rawInput = infile && !retry ? inputs : inputs[0];
  } catch (e) {
    fail(`入力 JSON のパースに失敗しました: ${e.message}`);
  }

  let ctx;
  try {
    ctx = readArtifact(context);
  } catch (e) {
    fail(e.message);
  }

  let prev = null;
  if (retry) {
    try {
      prev = readArtifact(retry);
    } catch (e) {
      fail(`--retry の前回 FINDINGS を読めません: ${e.message}`);
    }
  }

  const diffText = execFileSync("git", buildDiffArgs(ctx), {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  });

  let result;
  try {
    result = processFindings(rawInput, { ctx, diffText, prev });
  } catch (e) {
    fail(e.message);
  }

  console.log(writeArtifact("findings", result));
}

// ---- インラインテスト --------------------------------------------------------
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  const ctx = {
    changedFiles: ["src/a.js", "src/b.js"],
    excludedFiles: ["dist/x.min.js"],
  };
  // src/a.js は 5 行の新規ファイル、src/b.js は 3 行の新規ファイル。
  const diffText = [
    "diff --git a/src/a.js b/src/a.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/a.js",
    "@@ -0,0 +1,5 @@",
    "+line1",
    "+line2",
    "+line3",
    "+line4",
    "+line5",
    "diff --git a/src/b.js b/src/b.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/b.js",
    "@@ -0,0 +1,3 @@",
    "+alpha",
    "+beta",
    "+gamma",
  ].join("\n");

  const run = (raw, opts = {}) => processFindings(raw, { ctx, diffText, ...opts });

  const bug = (over) => ({
    agent: 3,
    path: "src/a.js",
    title: "バグ",
    body: "説明",
    existingCode: "line2",
    ...over,
  });
  const rule = (over) => ({
    agent: 1,
    path: "src/a.js",
    title: "ルール違反",
    body: "説明",
    existingCode: "line4",
    ruleRefs: ["CLAUDE.md"],
    ...over,
  });

  test("ID 付与: 入力順に f1..fN", () => {
    const { findings } = run([bug(), rule()]);
    assert.deepEqual(findings.map((f) => f.id), ["f1", "f2"]);
  });

  test("スキーマ検証: existingCode 欠落は invalid（全体は落とさない）", () => {
    const { findings, stats } = run([bug(), { agent: 3, path: "src/a.js", title: "x", body: "y" }]);
    assert.equal(findings[1].status, "invalid");
    assert.match(findings[1].errors.join(), /existingCode/);
    assert.equal(stats.invalid, 1);
    assert.equal(stats.valid, 1);
  });

  test("スキーマ検証: agent 1 で ruleRefs 欠落は invalid", () => {
    const { findings } = run([rule({ ruleRefs: undefined })]);
    assert.equal(findings[0].status, "invalid");
    assert.match(findings[0].errors.join(), /ruleRefs/);
  });

  test("スキーマ検証: agent 3 は ruleRefs 省略可・[] 補完", () => {
    const { findings } = run([bug()]);
    assert.equal(findings[0].status, "active");
    assert.deepEqual(findings[0].ruleRefs, []);
  });

  test("スコープ: changedFiles 外は out-of-scope", () => {
    const { findings, stats } = run([bug({ path: "src/other.js" })]);
    assert.equal(findings[0].status, "out-of-scope");
    assert.equal(stats.outOfScope, 1);
  });

  test("スコープ: excludedFiles は out-of-scope", () => {
    // excludedFiles は changedFiles に含まれない前提だが、両方に現れても弾く。
    const c2 = { changedFiles: ["dist/x.min.js"], excludedFiles: ["dist/x.min.js"] };
    const { findings } = processFindings([bug({ path: "dist/x.min.js", existingCode: "line2" })], {
      ctx: c2,
      diffText,
    });
    assert.equal(findings[0].status, "out-of-scope");
  });

  test("kind 導出: agent 3,4 → bug / 1,2,5 → rule", () => {
    const { findings } = run([
      bug({ agent: 3 }),
      bug({ agent: 4, existingCode: "line3" }),
      rule({ agent: 1 }),
      rule({ agent: 2, existingCode: "line5" }),
      rule({ agent: 5, existingCode: "line1" }),
    ]);
    assert.deepEqual(findings.map((f) => f.kind), ["bug", "bug", "rule", "rule", "rule"]);
  });

  test("アンカー解決: 成功で resolved:true + params", () => {
    const { findings, stats } = run([bug()]);
    assert.equal(findings[0].resolved, true);
    assert.equal(findings[0].params.line, 2);
    assert.equal(stats.resolved, 1);
  });

  test("アンカー解決: 失敗で resolved:false + reason", () => {
    const { findings, stats } = run([bug({ existingCode: "nonexistent" })]);
    assert.equal(findings[0].resolved, false);
    assert.ok(findings[0].reason);
    assert.equal(stats.unresolved, 1);
  });

  test("グルーピング: 行範囲が重なる同一 path+side は1グループ", () => {
    // line2..line3（f1）と line3..line4（f2）は line3 で重なる → 統合。
    const { groups } = run([
      bug({ existingCode: "line2\nline3" }),
      bug({ existingCode: "line3\nline4" }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].memberIds.length, 2);
    assert.equal(groups[0].needsMergeText, true);
    assert.deepEqual(groups[0].params, {
      startLine: 2,
      line: 4,
      startSide: "RIGHT",
      side: "RIGHT",
      subjectType: "LINE",
    });
  });

  test("グルーピング: 重ならない行範囲は別グループ", () => {
    const { groups } = run([bug({ existingCode: "line1" }), bug({ existingCode: "line5" })]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].needsMergeText, false);
  });

  test("グルーピング: bug+rule 混在は bug（由来種別優先）", () => {
    const { groups } = run([
      bug({ existingCode: "line2" }),
      rule({ existingCode: "line2" }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].kind, "bug");
  });

  test("グルーピング: 推移的連結（A-B, B-C なら A-B-C が1グループ）", () => {
    const { groups } = run([
      bug({ existingCode: "line1\nline2" }),
      bug({ existingCode: "line2\nline3" }),
      bug({ existingCode: "line3\nline4" }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].memberIds.length, 3);
    assert.equal(groups[0].params.startLine, 1);
    assert.equal(groups[0].params.line, 4);
  });

  test("グルーピング: 未解決の同一アンカー完全一致は統合", () => {
    const { groups } = run([
      bug({ existingCode: "ghost" }),
      bug({ existingCode: "ghost" }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].resolved, false);
    assert.equal(groups[0].needsMergeText, true);
  });

  test("グルーピング: 未解決でもアンカーが違えば別グループ", () => {
    const { groups } = run([
      bug({ existingCode: "ghost1" }),
      bug({ existingCode: "ghost2" }),
    ]);
    assert.equal(groups.length, 2);
  });

  test("配列の配列を自動フラット化する", () => {
    const { findings } = run([[bug()], [rule({ existingCode: "line5" })]]);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings.map((f) => f.id), ["f1", "f2"]);
  });

  test("--retry: パッチしたアンカーで再解決する", () => {
    const first = run([bug({ existingCode: "wronganchor" })]);
    assert.equal(first.findings[0].resolved, false);
    const retried = run([{ id: "f1", existingCode: "line2" }], { prev: first });
    assert.equal(retried.findings[0].resolved, true);
    assert.equal(retried.findings[0].params.line, 2);
    assert.equal(retried.stats.resolved, 1);
  });

  test("--retry: パッチに無い finding は維持される", () => {
    const first = run([bug({ existingCode: "line2" }), bug({ existingCode: "wrong" })]);
    const retried = run([{ id: "f2", existingCode: "line4" }], { prev: first });
    assert.equal(retried.findings[0].resolved, true); // f1 は元のまま
    assert.equal(retried.findings[0].params.line, 2);
    assert.equal(retried.findings[1].resolved, true); // f2 が再解決
    assert.equal(retried.findings[1].params.line, 4);
  });

  test("決定論性: 同一入力 → 同一出力", () => {
    const input = [bug({ existingCode: "line2" }), rule({ existingCode: "line4" })];
    const r1 = JSON.stringify(run(input));
    const r2 = JSON.stringify(run(input));
    assert.equal(r1, r2);
  });

  test("非配列 stdin は throw する", () => {
    assert.throws(() => run({ not: "array" }), /配列/);
  });
}
