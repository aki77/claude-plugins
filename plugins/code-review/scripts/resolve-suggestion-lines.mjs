#!/usr/bin/env node
// suggestion の行番号をレビュー対象の diff から機械的に確定するスクリプト。
//
// 背景: LLM に行番号（line/startLine）を推測させると diff にマッピングできない指定
// （例: 削除を含む修正を単一行で表現してしまう）が生まれ、GitHub 側で位置解決に失敗し
// `line: null` 化する。そこで alibaba/open-code-review 方式を移植し、LLM には「diff 中に
// 実在する連続コード片（existingCode）」だけを出させ、行番号はここで diff hunk との
// テキストマッチで確定する。マッチできなければ行番号を付けず resolved: false を返し、
// 呼び出し側でインライン化せずサマリへ退避させる（誤位置に貼らない）。
//
// 入力:
//   引数 --context <CTX> : collect-review-context.mjs が書き出した CTX ファイルのパス。
//                          そこから diffArgs / excludeArgs.git を読み、diff は
//                          `git -c core.quotepath=false diff <diffArgs> <excludeArgs.git>` で取得する。
//                          呼び出し元 SKILL がレビューに使う統一 diff（review-core.md の統一則）と
//                          完全に同一ソースになるため、アンカー（existingCode）との不整合が起きない。
//                          quotepath=false 固定なので非ASCIIパスも生の UTF-8 で出力される。
//   stdin (JSON)         : 課題の配列 [{ path, existingCode }]
//                            path         : 対象ファイルの相対パス
//                            existingCode : diff 中に実在する連続した数行（アンカー）
// 出力(stdout, JSON): 入力と同順の配列
//   解決成功: { path, resolved: true,  params: { line, startLine?, side?, startSide?, subjectType } }
//   解決失敗: { path, resolved: false, reason }
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ---- 引数パース --------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  if (args[0] === "--context" && args[1]) return { context: args[1] };
  console.error(
    "Usage: resolve-suggestion-lines.mjs --context <CTX>  (課題配列 JSON を stdin で渡す)"
  );
  process.exit(1);
}

// stdin（fd 0）を同期で最後まで読む。パイプ・リダイレクト双方で動く。
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ---- diff hunk パース --------------------------------------------------------
// unified diff の hunk ヘッダ。`@@ -oldStart,oldCount +newStart,newCount @@`
// count は省略可（1 行 hunk のとき）。
const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// `diff --git a/<path> b/<path>` からファイルパスを取り出す。
// diff は `git -c core.quotepath=false diff` で取得するため、非ASCIIパスもクォート＋
// 8進エスケープされず生の UTF-8 で出力される（呼び出し元 SKILL の統一 diff と同一形式）。
const fileHeaderRe = /^diff --git a\/(.+?) b\/(.+)$/;

// unified diff テキストを { path -> hunks[] } に分解する。
// 各 hunk は行の配列を持ち、各行は { text, oldLine, newLine } を持つ。
//   - context 行(' '): old/new 両方に行番号が付く
//   - added 行  ('+'): new のみ
//   - deleted 行('-'): old のみ
function parseDiff(diffText) {
  const files = new Map(); // path -> hunks[]
  let curPath = null;
  let curHunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diffText.split("\n")) {
    const fileMatch = raw.match(fileHeaderRe);
    if (fileMatch) {
      // b/ 側（新パス）を採用。リネーム時も新パスでコメントする。
      curPath = fileMatch[2];
      if (!files.has(curPath)) files.set(curPath, []);
      curHunk = null;
      continue;
    }
    // メタ行（index/---/+++/new file 等）は hunk ヘッダ以外スキップ。
    const hunkMatch = raw.match(hunkHeaderRe);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[3], 10);
      curHunk = { lines: [] };
      if (curPath) files.get(curPath).push(curHunk);
      continue;
    }
    if (!curHunk || curPath === null) continue;
    // hunk 本文。先頭 1 文字が種別。'\' は「改行なし」注釈なので無視。
    const marker = raw[0];
    if (marker === "\\") continue;
    const text = raw.slice(1);
    if (marker === "+") {
      curHunk.lines.push({ text, oldLine: null, newLine });
      newLine++;
    } else if (marker === "-") {
      curHunk.lines.push({ text, oldLine, newLine: null });
      oldLine++;
    } else if (marker === " ") {
      curHunk.lines.push({ text, oldLine, newLine });
      oldLine++;
      newLine++;
    }
    // それ以外（空文字＝末尾など）は無視。
  }
  return files;
}

// ---- 正規化 & マッチ ---------------------------------------------------------
// 比較用に行を正規化する。前後空白を除去し、LLM が付けがちな先頭の diff マーカー
// （'+' / '-' / 先頭スペース）を 1 つ剥がす。インデント差や貼り付け由来のマーカーを吸収。
function normalizeLine(line) {
  let s = line;
  if (s.startsWith("+") || s.startsWith("-")) s = s.slice(1);
  return s.trim();
}

function splitAndNormalize(code) {
  return code
    .split("\n")
    .map(normalizeLine)
    .filter((l) => l.length > 0); // 空行はアンカーにしない
}

// hunk 群から、指定 side（"new" or "old"）の行だけを行番号付きで平坦化する。
function sideLines(hunks, side) {
  const out = [];
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      const ln = side === "new" ? l.newLine : l.oldLine;
      if (ln != null) out.push({ lineNo: ln, norm: normalizeLine(l.text) });
    }
  }
  return out;
}

// side 行列（{lineNo, norm}[]）に対し、needle（正規化済み文字列配列）が連続一致する
// 箇所を探す。ちょうど 1 箇所だけ一致したとき { startLine, endLine } を返す。
// 0 箇所または複数箇所（曖昧）は null。
function matchConsecutive(lines, needle) {
  if (needle.length === 0) return null;
  const found = [];
  for (let i = 0; i + needle.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j].norm !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      found.push({
        startLine: lines[i].lineNo,
        endLine: lines[i + needle.length - 1].lineNo,
      });
    }
  }
  if (found.length !== 1) return null; // 0=不一致 / 2+=曖昧 はどちらも解決失敗扱い
  return found[0];
}

// 1 課題を解決する。new 側優先、なければ old 側でマッチを試みる。
function resolveIssue(issue, filesByPath) {
  const { path, existingCode } = issue;
  if (!path || !existingCode) {
    return { path, resolved: false, reason: "path または existingCode が未指定" };
  }
  const hunks = filesByPath.get(path);
  if (!hunks || hunks.length === 0) {
    return { path, resolved: false, reason: "対象ファイルの差分が見つからない" };
  }
  const needle = splitAndNormalize(existingCode);
  if (needle.length === 0) {
    return { path, resolved: false, reason: "existingCode が空" };
  }

  for (const side of ["new", "old"]) {
    const m = matchConsecutive(sideLines(hunks, side), needle);
    if (!m) continue;
    const commentSide = side === "new" ? "RIGHT" : "LEFT";
    if (m.startLine === m.endLine) {
      // 単一行: line と side のみ。GitHub の単一行コメント形式。
      return {
        path,
        resolved: true,
        params: { line: m.endLine, side: commentSide, subjectType: "LINE" },
      };
    }
    // 複数行: startLine..line を範囲指定。
    return {
      path,
      resolved: true,
      params: {
        startLine: m.startLine,
        line: m.endLine,
        startSide: commentSide,
        side: commentSide,
        subjectType: "LINE",
      },
    };
  }
  return {
    path,
    resolved: false,
    reason: "existingCode が diff に一意に一致しない（不一致または複数一致）",
  };
}

// ---- diff 取得 ---------------------------------------------------------------
// CTX（collect-review-context.mjs の出力）から `git diff` の引数を組み立てる。
// review-core.md の統一則「git diff <diffArgs> <excludeArgs.git>」と同じ並びを再現し、
// アンカー（existingCode）を取ったのと同一の diff をマッチ対象にする。
// core.quotepath=false を明示することで非ASCIIパスも生の UTF-8 で出力させる。
function buildDiffArgs(ctx) {
  const diffArgs = ctx.diffArgs ?? [];
  const excludeArgs = ctx.excludeArgs?.git ?? [];
  return ["-c", "core.quotepath=false", "diff", ...diffArgs, ...excludeArgs];
}

// ---- main --------------------------------------------------------------------
if (!process.env.NODE_TEST_CONTEXT) {
  const { context } = parseArgs(process.argv);

  let issues;
  try {
    issues = JSON.parse(readStdin());
  } catch (e) {
    console.error(`Error: stdin の JSON パースに失敗しました: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(issues)) {
    console.error("Error: stdin は課題オブジェクトの配列である必要があります");
    process.exit(1);
  }

  let ctx;
  try {
    ctx = JSON.parse(readFileSync(context, "utf8"));
  } catch (e) {
    console.error(`Error: CTX ファイルの読み込みに失敗しました（${context}）: ${e.message}`);
    process.exit(1);
  }

  const diffText = execFileSync("git", buildDiffArgs(ctx), { encoding: "utf8" });
  const filesByPath = parseDiff(diffText);

  const results = issues.map((issue) => resolveIssue(issue, filesByPath));
  console.log(JSON.stringify(results, null, 2));
}

// ---- インラインテスト --------------------------------------------------------
// `node --test plugins/code-review/scripts/resolve-suggestion-lines.mjs` で実行する。
// FS/ネットワーク非依存の純粋ロジック（diff パース・行番号復元・マッチ）を検証する。
if (process.env.NODE_TEST_CONTEXT) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  // 新規ファイル diff（全行 added、new 側 1..N に対応）を組み立てるヘルパ。
  // ロジック検証に必要な形（連続行・コメント行・重複しない行）だけを持つ汎用サンプル。
  const path = "src/sample.js";
  const bodyLines = [
    "export function first() {}", // 1
    "", // 2
    "// このコメントは自明なので削除したい", // 3
    "export function target() {}", // 4
    "const UNIQUE_MARKER = 1;", // 5
  ];
  const buildDiff = () =>
    [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${bodyLines.length} @@`,
      ...bodyLines.map((l) => "+" + l),
    ].join("\n");

  test("parseDiff: 新規ファイルの全行に new 側行番号が 1 から付く", () => {
    const files = parseDiff(buildDiff());
    const hunks = files.get(path);
    assert.ok(hunks && hunks.length === 1);
    const newLines = sideLines(hunks, "new");
    assert.equal(newLines[0].lineNo, 1);
    assert.equal(newLines[0].norm, "export function first() {}");
    // 4 行目 = target 定義
    const target = newLines.find((l) => l.norm === "export function target() {}");
    assert.equal(target.lineNo, 4);
  });

  test("hunkHeaderRe: count 省略ヘッダをパースできる", () => {
    const m = "@@ -1 +1 @@".match(hunkHeaderRe);
    assert.ok(m);
    assert.equal(m[1], "1");
    assert.equal(m[3], "1");
  });

  test("再現ケース: コメント削除(2行→1行)は範囲 startLine..line を返す", () => {
    // 削除したいコメント行(3)と残す行(4)を範囲に含めるアンカー。
    // → startLine:3, line:4 が返り、suggestion 本文から 3 行目を省けば削除になる。
    const files = parseDiff(buildDiff());
    const r = resolveIssue(
      {
        path,
        existingCode:
          "// このコメントは自明なので削除したい\nexport function target() {}",
      },
      files
    );
    assert.equal(r.resolved, true);
    assert.deepEqual(r.params, {
      startLine: 3,
      line: 4,
      startSide: "RIGHT",
      side: "RIGHT",
      subjectType: "LINE",
    });
  });

  test("単一行アンカーは line と side のみ（startLine なし）", () => {
    const files = parseDiff(buildDiff());
    const r = resolveIssue(
      { path, existingCode: "const UNIQUE_MARKER = 1;" },
      files
    );
    assert.equal(r.resolved, true);
    assert.deepEqual(r.params, { line: 5, side: "RIGHT", subjectType: "LINE" });
  });

  test("正規化: インデント差・diff マーカー付き入力でも一致する", () => {
    const files = parseDiff(buildDiff());
    const r = resolveIssue(
      // 先頭に diff マーカー '+' と余分なインデントを付けても吸収される
      { path, existingCode: "+   export function target() {}" },
      files
    );
    assert.equal(r.resolved, true);
    assert.equal(r.params.line, 4);
    assert.equal(r.params.subjectType, "LINE");
  });

  test("不一致の existingCode は resolved:false", () => {
    const files = parseDiff(buildDiff());
    const r = resolveIssue(
      { path, existingCode: "export function nonexistent() {}" },
      files
    );
    assert.equal(r.resolved, false);
    assert.match(r.reason, /一致/);
  });

  test("複数一致（曖昧）は resolved:false", () => {
    // 同一行が 2 回出現する diff を作る。
    const diff = [
      "diff --git a/src/dup.js b/src/dup.js",
      "--- /dev/null",
      "+++ b/src/dup.js",
      "@@ -0,0 +1,3 @@",
      "+dup",
      "+other",
      "+dup",
    ].join("\n");
    const files = parseDiff(diff);
    const r = resolveIssue({ path: "src/dup.js", existingCode: "dup" }, files);
    assert.equal(r.resolved, false);
  });

  test("差分にないファイルは resolved:false", () => {
    const files = parseDiff(buildDiff());
    const r = resolveIssue(
      { path: "src/other.js", existingCode: "anything" },
      files
    );
    assert.equal(r.resolved, false);
    assert.match(r.reason, /差分が見つからない/);
  });

  test("削除行(old側)にもマッチする", () => {
    const diff = [
      "diff --git a/src/edit.js b/src/edit.js",
      "--- a/src/edit.js",
      "+++ b/src/edit.js",
      "@@ -10,3 +10,2 @@",
      " keep_before",
      "-removed_line",
      " keep_after",
    ].join("\n");
    const files = parseDiff(diff);
    const r = resolveIssue(
      { path: "src/edit.js", existingCode: "removed_line" },
      files
    );
    assert.equal(r.resolved, true);
    // old 側 10=keep_before, 11=removed_line
    assert.equal(r.params.line, 11);
    assert.equal(r.params.side, "LEFT");
  });

  test("非ASCIIパス: quotepath=false の生UTF-8 diff で行番号を解決できる", () => {
    // `git -c core.quotepath=false diff` は非ASCIIパスをクォート/8進エスケープせず
    // 生の UTF-8 で出力する。その diff（呼び出し元 SKILL の統一 diff と同一形式）を
    // そのままパースでき、stdin の UTF-8 パスと一致することを確認する。
    const nonAsciiPath = "docs/仕様メモ.md";
    const diff = [
      `diff --git a/${nonAsciiPath} b/${nonAsciiPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${nonAsciiPath}`,
      "@@ -0,0 +1,2 @@",
      "+# 見出し",
      "+本文行",
    ].join("\n");
    const files = parseDiff(diff);
    assert.ok(files.get(nonAsciiPath), "UTF-8 パスで hunk が引けること");
    const r = resolveIssue({ path: nonAsciiPath, existingCode: "# 見出し" }, files);
    assert.equal(r.resolved, true);
    assert.equal(r.params.line, 1);
    assert.equal(r.params.side, "RIGHT");
  });

  test("buildDiffArgs: range モードは core.quotepath=false 付きで range を渡す", () => {
    const args = buildDiffArgs({ diffArgs: ["abc123...HEAD"], excludeArgs: { git: [] } });
    assert.deepEqual(args, ["-c", "core.quotepath=false", "diff", "abc123...HEAD"]);
  });

  test("buildDiffArgs: staged モードと除外引数を連結する", () => {
    const args = buildDiffArgs({
      diffArgs: ["--staged"],
      excludeArgs: { git: ["--", ".", ":(exclude)dist/x.js"] },
    });
    assert.deepEqual(args, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--staged",
      "--",
      ".",
      ":(exclude)dist/x.js",
    ]);
  });

  test("buildDiffArgs: diffArgs/excludeArgs 欠落時も落ちない", () => {
    assert.deepEqual(buildDiffArgs({}), ["-c", "core.quotepath=false", "diff"]);
  });
}
