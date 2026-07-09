#!/usr/bin/env node
// 検証エージェント（ステップ6）が返した verdict を機械適用し、FINAL 成果物にする。
// 旧ステップ6「検証されなかった課題は除外する」を、暗黙でなく成果物に残す形で機械化する
// （alibaba/open-code-review の executeReviewFilter に相当。LLM は判定のみ、削除はコード）。
//
// 検証エージェントは issue ごとに `{id, verdict, reason}` の1オブジェクトを返す。このスクリプトが:
//   - confirmed のみを最終課題として残す
//   - rejected は理由付きで記録（黙って消さない）
//   - stdin に現れない issue は unverified として除外（検証エージェント失敗時の縮退もこの経路へ）
//
// 入力:
//   引数 --issues <ISSUES> : merge-findings.mjs の ISSUES ファイルパス。
//   stdin (JSON): [{ id, verdict: "confirmed"|"rejected", reason }]。
// 出力(stdout): FINAL 成果物ファイルのパス（1行）。中身は
//   { issues:[confirmed の issue 全体], rejected:[{id,path,title,reason}], unverified:[id...], stats }
// confirmed の issue は merge-findings.mjs が転写した category/severity をそのまま保持する
// （このスクリプトは issue を丸ごと保持するため、コード変更なしで FINAL まで自動的に携行される）。
import { fileURLToPath } from "node:url";
import { fail, parseFlags, readArtifact, readInputJsonList, writeArtifact } from "./lib/artifact.mjs";

const VALID_VERDICTS = new Set(["confirmed", "rejected"]);

// issuesDoc（ISSUES の中身）と verdicts（検証結果配列）から FINAL を組み立てる純粋関数。
export function applyVerdicts(issuesDoc, verdicts) {
  const { issues } = issuesDoc;
  const issueById = new Map(issues.map((i) => [i.id, i]));

  if (!Array.isArray(verdicts)) {
    throw new Error("stdin は [{id, verdict, reason}] の配列である必要があります");
  }

  const verdictById = new Map();
  for (const v of verdicts) {
    if (!v || typeof v.id !== "string") {
      throw new Error("verdict の各要素は id（文字列）を持つ必要があります");
    }
    if (!issueById.has(v.id)) {
      throw new Error(`未知の issue id: ${v.id}`);
    }
    if (verdictById.has(v.id)) {
      throw new Error(`issue id=${v.id} の verdict が重複しています`);
    }
    if (!VALID_VERDICTS.has(v.verdict)) {
      throw new Error(`issue id=${v.id} の verdict は "confirmed" または "rejected" である必要があります`);
    }
    verdictById.set(v.id, v);
  }

  const confirmed = [];
  const rejected = [];
  const unverified = [];
  for (const issue of issues) {
    const v = verdictById.get(issue.id);
    if (!v) {
      // stdin に現れない issue は検証されなかったものとして除外（成果物に残す）。
      unverified.push(issue.id);
    } else if (v.verdict === "confirmed") {
      confirmed.push(issue);
    } else {
      rejected.push({ id: issue.id, path: issue.path, title: issue.title, reason: v.reason ?? "" });
    }
  }

  const stats = {
    total: issues.length,
    confirmed: confirmed.length,
    rejected: rejected.length,
    unverified: unverified.length,
  };

  return { issues: confirmed, rejected, unverified, stats };
}

// ---- main --------------------------------------------------------------------
if (!process.env.NODE_TEST_CONTEXT) {
  const { issues, infile } = parseFlags(process.argv, {
    flags: ["--issues", "--infile"],
    required: ["--issues"],
    multi: ["--infile"],
    usage:
      "apply-verdicts.mjs --issues <ISSUES> --infile <v1.json> [--infile <v2.json> ...]  (各 --infile は verdict オブジェクト1件 or 配列。--infile 省略時は stdin で配列)",
  });

  let issuesDoc;
  try {
    issuesDoc = readArtifact(issues);
  } catch (e) {
    fail(e.message);
  }

  // 各検証エージェントは verdict オブジェクト1件を1ファイルに書く（--infile 複数）。
  // flat() で、各ファイルが単一オブジェクト・配列のどちらで書かれていても verdict 配列に均す
  // （stdin fallback の verdict 配列1本も同様に均される）。
  let verdicts;
  try {
    verdicts = readInputJsonList(infile).flat();
  } catch (e) {
    fail(`入力 JSON のパースに失敗しました: ${e.message}`);
  }

  let result;
  try {
    result = applyVerdicts(issuesDoc, verdicts);
  } catch (e) {
    fail(e.message);
  }

  console.log(writeArtifact("final", result));
}

// ---- インラインテスト --------------------------------------------------------
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  const doc = {
    issues: [
      { id: "g1", path: "a.js", title: "T1", kind: "bug", category: "security", severity: "critical", resolved: true },
      { id: "g2", path: "b.js", title: "T2", kind: "rule", category: "rule-violation", severity: "medium", resolved: true },
      { id: "g3", path: "c.js", title: "T3", kind: "bug", category: "performance", severity: "low", resolved: false },
    ],
  };

  test("confirmed の issue は category/severity を丸ごと携行する", () => {
    const r = applyVerdicts(doc, [{ id: "g1", verdict: "confirmed" }]);
    assert.equal(r.issues[0].category, "security");
    assert.equal(r.issues[0].severity, "critical");
  });

  test("confirmed のみ issues に残す", () => {
    const r = applyVerdicts(doc, [
      { id: "g1", verdict: "confirmed" },
      { id: "g2", verdict: "rejected", reason: "誤検知" },
      { id: "g3", verdict: "confirmed" },
    ]);
    assert.deepEqual(r.issues.map((i) => i.id), ["g1", "g3"]);
  });

  test("rejected を理由付きで記録する", () => {
    const r = applyVerdicts(doc, [
      { id: "g1", verdict: "confirmed" },
      { id: "g2", verdict: "rejected", reason: "誤検知" },
      { id: "g3", verdict: "confirmed" },
    ]);
    assert.deepEqual(r.rejected, [{ id: "g2", path: "b.js", title: "T2", reason: "誤検知" }]);
  });

  test("stdin に無い issue は unverified として除外", () => {
    const r = applyVerdicts(doc, [{ id: "g1", verdict: "confirmed" }]);
    assert.deepEqual(r.issues.map((i) => i.id), ["g1"]);
    assert.deepEqual(r.unverified, ["g2", "g3"]);
  });

  test("全 verdict 欠落（検証エージェント全滅）→ 全件 unverified", () => {
    const r = applyVerdicts(doc, []);
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.unverified, ["g1", "g2", "g3"]);
  });

  test("stats を集計する", () => {
    const r = applyVerdicts(doc, [
      { id: "g1", verdict: "confirmed" },
      { id: "g2", verdict: "rejected", reason: "x" },
    ]);
    assert.deepEqual(r.stats, { total: 3, confirmed: 1, rejected: 1, unverified: 1 });
  });

  test("エラー: 未知 id", () => {
    assert.throws(() => applyVerdicts(doc, [{ id: "g99", verdict: "confirmed" }]), /未知の issue id/);
  });

  test("エラー: 重複 id", () => {
    assert.throws(
      () => applyVerdicts(doc, [{ id: "g1", verdict: "confirmed" }, { id: "g1", verdict: "rejected" }]),
      /重複/
    );
  });

  test("エラー: enum 外の verdict", () => {
    assert.throws(() => applyVerdicts(doc, [{ id: "g1", verdict: "maybe" }]), /confirmed.*rejected/);
  });

  test("エラー: stdin が配列でない", () => {
    assert.throws(() => applyVerdicts(doc, { id: "g1" }), /配列/);
  });
}
