#!/usr/bin/env node
// ステップ2（サマリ+クラスタ分割エージェント）が出した clusters JSON を機械検証・修復し、
// CLUSTERS 成果物にする。エージェント4（クロスファイル整合性）をクラスタ単位で並列起動
// するための入力を、決定論的に整える。
//
// 設計方針（ユーザー決定済み）: クラスタ分割は LLM 維持 + スクリプト検証。検証・修復が
// 破綻したら「全変更ファイルを単一クラスタとみなす」決定論的縮退へ一本化する。**サマリ
// エージェントが失敗した場合も stdin `[]` でこのスクリプトを通し、縮退経路をここに集約する。**
//
// 入力:
//   引数 --context <CTX> : collect-review-context.mjs の CTX ファイルパス（changedFiles を読む）。
//   stdin (JSON): clusters 配列 [{ id, theme, changedFiles, symbols?, contextHints? }]。
//                 サマリ失敗時は `[]` を渡す（→ 縮退）。
// 出力(stdout): CLUSTERS 成果物ファイルのパス（1行）。中身は
//   { clusters, fallback, removedPaths, appendedPaths }
import { fileURLToPath } from "node:url";
import { fail, parseFlags, readArtifact, readSingleInputJson, writeArtifact } from "./lib/artifact.mjs";

const MAX_CLUSTERS = 3;

// 単一クラスタ（全変更ファイル）を作る。縮退先。
function singleCluster(changedFiles) {
  return [{ id: 1, theme: "全変更ファイル", changedFiles: [...changedFiles], symbols: [], contextHints: [] }];
}

// tier（tiny/small）による決定論的な単一クラスタ縮退の結果を作る純粋関数。
// エージェント2の出力内容によらず縮退させるため clusters のパース前に使う。
// fallback（rawClusters が壊れていた縮退）とは区別し tierReduced:true で理由を残す。
export function tierReducedClusters(changedFiles) {
  return {
    clusters: singleCluster(changedFiles),
    fallback: false,
    tierReduced: true,
    removedPaths: [],
    appendedPaths: [],
  };
}

// clusters を検証・修復する純粋関数。
//   changedFiles: CTX の変更ファイル配列（レビュー対象。除外済み）
//   rawClusters : ステップ2エージェントの出力（任意の型でありうる）
// 戻り値: { clusters, fallback, removedPaths, appendedPaths }
//   fallback=true のとき単一クラスタへ縮退した（rawClusters が使い物にならなかった）。
export function validateClusters(rawClusters, changedFiles) {
  const changedSet = new Set(changedFiles);
  // 単一クラスタ縮退の唯一の生成点。removedPaths を先に宣言し（縮退前に溜まった分をそのまま
  // 携行する）、全ての縮退条件がこの1か所を呼ぶ。appendedPaths は縮退では常に空（全ファイルを
  // 1クラスタに載せるので「未カバー追加」の概念がない）。
  const removedPaths = [];
  const bail = () => ({ clusters: singleCluster(changedFiles), fallback: true, removedPaths, appendedPaths: [] });

  // 縮退条件1: 配列でない / 3超過 / 要素に theme・changedFiles 欠落。
  if (!Array.isArray(rawClusters) || rawClusters.length > MAX_CLUSTERS) {
    return bail();
  }
  for (const c of rawClusters) {
    if (!c || typeof c !== "object" || typeof c.theme !== "string" || c.theme.trim() === "") {
      return bail();
    }
    if (!Array.isArray(c.changedFiles)) {
      return bail();
    }
  }

  // 修復: changedFiles を CTX と積集合（diff 外パスを除去）。symbols/contextHints を [] 補完。
  const repaired = rawClusters.map((c) => {
    const kept = [];
    for (const p of c.changedFiles) {
      if (changedSet.has(p)) kept.push(p);
      else removedPaths.push(p);
    }
    return {
      theme: c.theme,
      changedFiles: [...new Set(kept)],
      symbols: Array.isArray(c.symbols) ? c.symbols : [],
      contextHints: Array.isArray(c.contextHints) ? c.contextHints : [],
    };
  });

  // 空クラスタ（積集合で全ファイルが落ちた）を削除。
  let clusters = repaired.filter((c) => c.changedFiles.length > 0);

  // 縮退条件2: 修復後0件。
  if (clusters.length === 0) {
    return bail();
  }

  // 未カバーの変更ファイルを、ファイル数最小のクラスタ（同数なら並び順で先＝id 最小相当）へ追加。
  // 同一ファイルが複数クラスタに現れる場合は最初のクラスタのものを正とし、後続からは既に
  // removedPaths ではなく単純に重複排除（積集合時点で各クラスタ内は unique、跨りは以下で解消）。
  const covered = new Set();
  for (const c of clusters) {
    c.changedFiles = c.changedFiles.filter((p) => {
      if (covered.has(p)) return false; // 別クラスタが既に保持 → こちらからは落とす
      covered.add(p);
      return true;
    });
  }
  // 跨り解消で空になったクラスタを再度削除。
  clusters = clusters.filter((c) => c.changedFiles.length > 0);
  if (clusters.length === 0) {
    return bail();
  }

  const appendedPaths = [];
  for (const p of changedFiles) {
    if (covered.has(p)) continue;
    appendedPaths.push(p);
    // ファイル数最小のクラスタ（同数なら配列の先頭側）へ寄せる。
    const target = clusters.reduce((a, b) => (a.changedFiles.length <= b.changedFiles.length ? a : b));
    target.changedFiles.push(p);
    covered.add(p);
  }

  // id 振り直し（1始まり連番）。
  clusters.forEach((c, i) => {
    c.id = i + 1;
  });
  // id を先頭キーにするため並べ替え（id, theme, ...）。
  const ordered = clusters.map((c) => ({
    id: c.id,
    theme: c.theme,
    changedFiles: c.changedFiles,
    symbols: c.symbols,
    contextHints: c.contextHints,
  }));

  return { clusters: ordered, fallback: false, removedPaths, appendedPaths };
}

// ---- main --------------------------------------------------------------------
if (!process.env.NODE_TEST_CONTEXT) {
  const { context, infile } = parseFlags(process.argv, {
    flags: ["--context", "--infile"],
    required: ["--context"],
    multi: ["--infile"],
    usage:
      "validate-clusters.mjs --context <CTX> --infile <clusters.json>  (--infile 省略時は stdin)",
  });

  let ctx;
  try {
    ctx = readArtifact(context);
  } catch (e) {
    fail(e.message);
  }
  const changedFiles = ctx.changedFiles ?? [];

  // fast-path（tiny/small）: 変更規模が小さいときはクラスタ分割を行わず単一クラスタへ
  // 決定論的に縮退させる（→ エージェント4が1インスタンスになる）。エージェント2の出力
  // 内容によらず縮退させるため、clusters をパースする前にここで確定させる。
  // fallback（rawClusters が使い物にならなかった縮退）とは区別し tierReduced で理由を残す。
  let result;
  if (ctx.tier && ctx.tier !== "normal") {
    result = tierReducedClusters(changedFiles);
  } else {
    // 入力が JSON でない/読めない場合も縮退で吸収する（サマリエージェント失敗時の縮退経路一本化）。
    let rawClusters;
    try {
      rawClusters = readSingleInputJson(infile);
    } catch {
      rawClusters = null; // → validateClusters が単一クラスタへ縮退させる
    }
    result = validateClusters(rawClusters, changedFiles);
  }
  console.log(writeArtifact("clusters", result));
}

// ---- インラインテスト --------------------------------------------------------
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  const changed = ["a.js", "b.js", "c.js", "d.js"];

  test("正常通過: 全ファイルをカバーする2クラスタはそのまま", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js", "b.js"], symbols: ["f"], contextHints: ["x.js"] },
      { id: 2, theme: "T2", changedFiles: ["c.js", "d.js"] },
    ];
    const r = validateClusters(raw, changed);
    assert.equal(r.fallback, false);
    assert.equal(r.clusters.length, 2);
    assert.deepEqual(r.clusters[1].symbols, []); // 欠落補完
    assert.deepEqual(r.clusters[1].contextHints, []);
  });

  test("縮退: 配列でない入力は単一クラスタ", () => {
    const r = validateClusters(null, changed);
    assert.equal(r.fallback, true);
    assert.equal(r.clusters.length, 1);
    assert.deepEqual(r.clusters[0].changedFiles, changed);
  });

  test("縮退: 4クラスタ（3超過）は単一クラスタ", () => {
    const raw = [1, 2, 3, 4].map((n) => ({ id: n, theme: `T${n}`, changedFiles: [] }));
    const r = validateClusters(raw, changed);
    assert.equal(r.fallback, true);
  });

  test("縮退: theme 欠落要素があれば単一クラスタ", () => {
    const raw = [{ id: 1, changedFiles: ["a.js"] }];
    const r = validateClusters(raw, changed);
    assert.equal(r.fallback, true);
  });

  test("縮退: 空配列 [] は単一クラスタ（サマリ失敗経路）", () => {
    const r = validateClusters([], changed);
    assert.equal(r.fallback, true);
    assert.deepEqual(r.clusters[0].changedFiles, changed);
  });

  test("修復: diff 外パスを除去し removedPaths に記録", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js", "ghost.js"] },
      { id: 2, theme: "T2", changedFiles: ["b.js", "c.js", "d.js"] },
    ];
    const r = validateClusters(raw, changed);
    assert.equal(r.fallback, false);
    assert.deepEqual(r.removedPaths, ["ghost.js"]);
    assert.deepEqual(r.clusters[0].changedFiles, ["a.js"]);
  });

  test("修復: 未カバーの変更ファイルを最小クラスタへ追加し appendedPaths に記録", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js"] },
      { id: 2, theme: "T2", changedFiles: ["b.js"] },
    ];
    const r = validateClusters(raw, changed);
    // c.js, d.js が未カバー → それぞれ最小クラスタへ
    assert.deepEqual(r.appendedPaths.sort(), ["c.js", "d.js"]);
    const all = r.clusters.flatMap((c) => c.changedFiles).sort();
    assert.deepEqual(all, changed);
  });

  test("修復: 全ファイル diff 外 → 空クラスタ削除 → 縮退", () => {
    const raw = [{ id: 1, theme: "T1", changedFiles: ["ghost.js"] }];
    const r = validateClusters(raw, changed);
    assert.equal(r.fallback, true);
  });

  test("id 振り直し: 1始まり連番になる", () => {
    const raw = [
      { id: 5, theme: "T1", changedFiles: ["a.js", "b.js"] },
      { id: 9, theme: "T2", changedFiles: ["c.js", "d.js"] },
    ];
    const r = validateClusters(raw, changed);
    assert.deepEqual(r.clusters.map((c) => c.id), [1, 2]);
  });

  test("跨り解消: 同一ファイルが複数クラスタなら先頭クラスタのみ保持", () => {
    const raw = [
      { id: 1, theme: "T1", changedFiles: ["a.js", "b.js"] },
      { id: 2, theme: "T2", changedFiles: ["b.js", "c.js", "d.js"] },
    ];
    const r = validateClusters(raw, changed);
    assert.deepEqual(r.clusters[0].changedFiles, ["a.js", "b.js"]);
    assert.deepEqual(r.clusters[1].changedFiles, ["c.js", "d.js"]); // b.js は落ちる
  });

  test("tierReducedClusters: 全変更ファイルを単一クラスタにまとめ tierReduced を立てる", () => {
    const r = tierReducedClusters(changed);
    assert.equal(r.tierReduced, true);
    assert.equal(r.fallback, false); // fallback（壊れた入力）とは区別する
    assert.equal(r.clusters.length, 1);
    assert.deepEqual(r.clusters[0].changedFiles, changed);
    assert.deepEqual(r.removedPaths, []);
    assert.deepEqual(r.appendedPaths, []);
  });
}
