#!/usr/bin/env node
// FINDINGS のグループ構造と、LLM が書いた統合文章（複数メンバーのグループのみ）を機械結合し、
// ISSUES 成果物にする。旧ステップ4「重複統合」のうち **統合可否・構造転写はスクリプト、
// 統合文章のみ LLM** という分担を実装する。
//
// singleton グループ（メンバー1件）は唯一の finding の title/body を自動コピーする。
// path / kind / params / resolved / existingCode（グループ先頭メンバー）/ ruleRefs（和集合）は
// **すべてスクリプトが機械転写**し、LLM を経由させない（転記ミス防止）。
//
// 入力:
//   引数 --findings <FINDINGS> : process-findings.mjs の FINDINGS ファイルパス。
//   stdin (JSON): [{ groupId, title, body }] （needsMergeText:true の全グループ分**のみ**）。
// 出力(stdout): ISSUES 成果物ファイルのパス（1行）。中身は
//   { issues:[{ id, path, kind, title, body, ruleRefs, existingCode, resolved, params?, sourceFindingIds }], stats }
import { fileURLToPath } from "node:url";
import { fail, parseFlags, readArtifact, readStdinJson, writeArtifact } from "./lib/artifact.mjs";

// findingsDoc（FINDINGS の中身）と mergeTexts（LLM 統合文章配列）から ISSUES を組み立てる純粋関数。
export function mergeFindings(findingsDoc, mergeTexts) {
  const { findings, groups } = findingsDoc;
  const findingById = new Map(findings.map((f) => [f.id, f]));

  if (!Array.isArray(mergeTexts)) {
    throw new Error("stdin は [{groupId, title, body}] の配列である必要があります");
  }

  // 統合文章を groupId で引けるようにしつつ、重複・未知・欠落を検証する。
  // needTextGroups（needsMergeText:true）が「文章が必要なグループ」の唯一の真。既知グループの
  // うちこれに含まれないものは singleton なので、別途 singletonGroups Set は持たない。
  const textByGroup = new Map();
  const needTextGroups = new Set(groups.filter((g) => g.needsMergeText).map((g) => g.id));
  const knownGroups = new Set(groups.map((g) => g.id));

  for (const t of mergeTexts) {
    if (!t || typeof t.groupId !== "string") {
      throw new Error("統合文章の各要素は groupId（文字列）を持つ必要があります");
    }
    if (!knownGroups.has(t.groupId)) {
      throw new Error(`未知の groupId: ${t.groupId}`);
    }
    if (!needTextGroups.has(t.groupId)) {
      throw new Error(
        `groupId=${t.groupId} は単一メンバーのため統合文章は不要です（自動コピーされます）`
      );
    }
    if (textByGroup.has(t.groupId)) {
      throw new Error(`groupId=${t.groupId} の統合文章が重複しています`);
    }
    if (typeof t.title !== "string" || t.title.trim() === "" || typeof t.body !== "string" || t.body.trim() === "") {
      throw new Error(`groupId=${t.groupId} の統合文章は title/body（非空文字列）が必要です`);
    }
    textByGroup.set(t.groupId, { title: t.title, body: t.body });
  }
  // needsMergeText:true の全グループに文章が供給されているか。
  for (const gid of needTextGroups) {
    if (!textByGroup.has(gid)) {
      throw new Error(`groupId=${gid} は複数メンバーですが統合文章が供給されていません`);
    }
  }

  const issues = groups.map((g) => {
    const members = g.memberIds.map((id) => findingById.get(id));
    const head = members[0];
    // title/body: singleton は唯一のメンバーから自動コピー、複数は LLM 統合文章。
    let title;
    let body;
    if (g.needsMergeText) {
      ({ title, body } = textByGroup.get(g.id));
    } else {
      title = head.title;
      body = head.body;
    }
    // ruleRefs は全メンバーの和集合（順序安定・重複排除）。
    const ruleRefs = [...new Set(members.flatMap((m) => m.ruleRefs ?? []))];
    const issue = {
      id: g.id,
      path: g.path,
      kind: g.kind,
      title,
      body,
      ruleRefs,
      existingCode: head.existingCode, // グループ先頭メンバーのアンカーを代表に採用
      resolved: g.resolved,
      sourceFindingIds: g.memberIds,
    };
    if (g.resolved) issue.params = g.params;
    else if (g.reason) issue.reason = g.reason;
    return issue;
  });

  const stats = {
    groups: groups.length,
    issues: issues.length,
    merged: groups.filter((g) => g.needsMergeText).length,
    resolved: issues.filter((i) => i.resolved).length,
    unresolved: issues.filter((i) => !i.resolved).length,
  };

  return { issues, stats };
}

// ---- main --------------------------------------------------------------------
if (!process.env.NODE_TEST_CONTEXT) {
  const { findings } = parseFlags(process.argv, {
    flags: ["--findings"],
    required: ["--findings"],
    usage: "merge-findings.mjs --findings <FINDINGS>  (統合文章 [{groupId,title,body}] を stdin で渡す)",
  });

  let findingsDoc;
  try {
    findingsDoc = readArtifact(findings);
  } catch (e) {
    fail(e.message);
  }

  let mergeTexts;
  try {
    mergeTexts = readStdinJson();
  } catch (e) {
    fail(`stdin の JSON パースに失敗しました: ${e.message}`);
  }

  let result;
  try {
    result = mergeFindings(findingsDoc, mergeTexts);
  } catch (e) {
    fail(e.message);
  }

  console.log(writeArtifact("issues", result));
}

// ---- インラインテスト --------------------------------------------------------
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  const doc = {
    findings: [
      { id: "f1", path: "a.js", kind: "bug", title: "T1", body: "B1", existingCode: "x", ruleRefs: [], params: { line: 2, side: "RIGHT", subjectType: "LINE" }, resolved: true, status: "active" },
      { id: "f2", path: "a.js", kind: "rule", title: "T2", body: "B2", existingCode: "x", ruleRefs: ["CLAUDE.md"], params: { line: 2, side: "RIGHT", subjectType: "LINE" }, resolved: true, status: "active" },
      { id: "f3", path: "b.js", kind: "rule", title: "T3", body: "B3", existingCode: "y", ruleRefs: ["REVIEW.md"], resolved: false, reason: "不一致", status: "active" },
    ],
    groups: [
      { id: "g1", path: "a.js", kind: "bug", resolved: true, memberIds: ["f1", "f2"], needsMergeText: true, params: { line: 2, side: "RIGHT", subjectType: "LINE" } },
      { id: "g2", path: "b.js", kind: "rule", resolved: false, memberIds: ["f3"], needsMergeText: false, reason: "不一致" },
    ],
  };

  test("複数メンバーグループは LLM 統合文章を採用し、ruleRefs は和集合", () => {
    const { issues } = mergeFindings(doc, [{ groupId: "g1", title: "統合", body: "統合本文" }]);
    const g1 = issues.find((i) => i.id === "g1");
    assert.equal(g1.title, "統合");
    assert.equal(g1.body, "統合本文");
    assert.equal(g1.kind, "bug");
    assert.deepEqual(g1.ruleRefs, ["CLAUDE.md"]); // f1 は []、f2 は CLAUDE.md
    assert.deepEqual(g1.params, { line: 2, side: "RIGHT", subjectType: "LINE" });
    assert.deepEqual(g1.sourceFindingIds, ["f1", "f2"]);
  });

  test("singleton グループは唯一メンバーの title/body を自動コピー", () => {
    const { issues } = mergeFindings(doc, [{ groupId: "g1", title: "統合", body: "統合本文" }]);
    const g2 = issues.find((i) => i.id === "g2");
    assert.equal(g2.title, "T3");
    assert.equal(g2.body, "B3");
    assert.equal(g2.resolved, false);
    assert.equal(g2.reason, "不一致");
    assert.equal("params" in g2, false);
  });

  test("エラー: needsMergeText グループに文章が無い", () => {
    assert.throws(() => mergeFindings(doc, []), /統合文章が供給されていません/);
  });

  test("エラー: 未知の groupId", () => {
    assert.throws(
      () => mergeFindings(doc, [{ groupId: "g1", title: "t", body: "b" }, { groupId: "g99", title: "t", body: "b" }]),
      /未知の groupId/
    );
  });

  test("エラー: singleton へ文章供給", () => {
    assert.throws(
      () => mergeFindings(doc, [{ groupId: "g1", title: "t", body: "b" }, { groupId: "g2", title: "t", body: "b" }]),
      /単一メンバー/
    );
  });

  test("エラー: 重複 groupId", () => {
    assert.throws(
      () => mergeFindings(doc, [{ groupId: "g1", title: "t", body: "b" }, { groupId: "g1", title: "t2", body: "b2" }]),
      /重複/
    );
  });

  test("エラー: title/body 空", () => {
    assert.throws(
      () => mergeFindings(doc, [{ groupId: "g1", title: "  ", body: "b" }]),
      /title\/body/
    );
  });

  test("エラー: stdin が配列でない", () => {
    assert.throws(() => mergeFindings(doc, { groupId: "g1" }), /配列/);
  });

  test("stats を集計する", () => {
    const { stats } = mergeFindings(doc, [{ groupId: "g1", title: "t", body: "b" }]);
    assert.deepEqual(stats, { groups: 2, issues: 2, merged: 1, resolved: 1, unresolved: 1 });
  });
}
