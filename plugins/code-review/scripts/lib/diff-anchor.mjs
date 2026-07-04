// diff パース・アンカー（existingCode）解決の共通モジュール。
//
// 背景: LLM に行番号（line/startLine）を推測させると diff にマッピングできない指定
// （例: 削除を含む修正を単一行で表現してしまう）が生まれ、GitHub 側で位置解決に失敗し
// `line: null` 化する。そこで alibaba/open-code-review 方式を移植し、LLM には「diff 中に
// 実在する連続コード片（existingCode）」だけを出させ、行番号はここで diff hunk との
// テキストマッチで確定する。マッチできなければ行番号を付けず resolved: false を返し、
// 呼び出し側でインライン化せずサマリへ退避させる（誤位置に貼らない）。
//
// このモジュールは複数スクリプト（process-findings.mjs 等）から import される純粋ロジック
// で、FS/ネットワークには依存しない（diff テキストと課題オブジェクトを受け取るだけ）。
import { fileURLToPath } from "node:url";

// ---- diff hunk パース --------------------------------------------------------
// unified diff の hunk ヘッダ。`@@ -oldStart,oldCount +newStart,newCount @@`
// count は省略可（1 行 hunk のとき）。
export const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// `diff --git a/<path> b/<path>` からファイルパスを取り出す。
// diff は `git -c core.quotepath=false diff` で取得するため、非ASCIIパスもクォート＋
// 8進エスケープされず生の UTF-8 で出力される（呼び出し元 SKILL の統一 diff と同一形式）。
export const fileHeaderRe = /^diff --git a\/(.+?) b\/(.+)$/;

// unified diff テキストを { path -> hunks[] } に分解する。
// 各 hunk は行の配列を持ち、各行は { text, oldLine, newLine } を持つ。
//   - context 行(' '): old/new 両方に行番号が付く
//   - added 行  ('+'): new のみ
//   - deleted 行('-'): old のみ
export function parseDiff(diffText) {
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
export function normalizeLine(line) {
  let s = line;
  if (s.startsWith("+") || s.startsWith("-")) s = s.slice(1);
  return s.trim();
}

export function splitAndNormalize(code) {
  return code
    .split("\n")
    .map(normalizeLine)
    .filter((l) => l.length > 0); // 空行はアンカーにしない
}

// hunk 群から、指定 side（"new" or "old"）の行だけを行番号付きで平坦化する。
export function sideLines(hunks, side) {
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
export function matchConsecutive(lines, needle) {
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

// 1 課題のアンカー（existingCode）を解決する。new 側優先、なければ old 側でマッチを試みる。
// 戻り値:
//   解決成功: { resolved: true,  side, params: { line, startLine?, side?, startSide?, subjectType } }
//   解決失敗: { resolved: false, reason }
// side（"new"|"old"）を params とは別に併記するのは、機械グルーピングで side をキーに
// 使うため（params には GitHub 用の "RIGHT"/"LEFT" が入る）。
export function resolveAnchor({ path, existingCode }, filesByPath) {
  if (!path || !existingCode) {
    return { resolved: false, reason: "path または existingCode が未指定" };
  }
  const hunks = filesByPath.get(path);
  if (!hunks || hunks.length === 0) {
    return { resolved: false, reason: "対象ファイルの差分が見つからない" };
  }
  const needle = splitAndNormalize(existingCode);
  if (needle.length === 0) {
    return { resolved: false, reason: "existingCode が空" };
  }

  for (const side of ["new", "old"]) {
    const m = matchConsecutive(sideLines(hunks, side), needle);
    if (!m) continue;
    const commentSide = side === "new" ? "RIGHT" : "LEFT";
    if (m.startLine === m.endLine) {
      // 単一行: line と side のみ。GitHub の単一行コメント形式。
      return {
        resolved: true,
        side,
        params: { line: m.endLine, side: commentSide, subjectType: "LINE" },
      };
    }
    // 複数行: startLine..line を範囲指定。
    return {
      resolved: true,
      side,
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
    resolved: false,
    reason: "existingCode が diff に一意に一致しない（不一致または複数一致）",
  };
}

// ---- diff 取得引数の組み立て -------------------------------------------------
// CTX（collect-review-context.mjs の出力）から `git diff` の引数を組み立てる。
// review-core.md の統一則「git diff <diffArgs> <excludeArgs.git>」と同じ並びを再現し、
// アンカー（existingCode）を取ったのと同一の diff をマッチ対象にする。
// core.quotepath=false を明示することで非ASCIIパスも生の UTF-8 で出力させる。
export function buildDiffArgs(ctx) {
  const diffArgs = ctx.diffArgs ?? [];
  const excludeArgs = ctx.excludeArgs?.git ?? [];
  return ["-c", "core.quotepath=false", "diff", ...diffArgs, ...excludeArgs];
}

// ---- インラインテスト --------------------------------------------------------
// `node --test plugins/code-review/scripts/lib/diff-anchor.mjs` で実行する。
// lib は複数スクリプトから import されるため、テストの二重登録を防ぐガードを
// 「NODE_TEST_CONTEXT かつ、このファイル自身が --test の対象（argv[1]）である」に
// 強化する（他スクリプトのテスト実行中に import されても登録されない）。
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  // 新規ファイル diff（全行 added、new 側 1..N に対応）を組み立てるヘルパ。
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
    const target = newLines.find((l) => l.norm === "export function target() {}");
    assert.equal(target.lineNo, 4);
  });

  test("hunkHeaderRe: count 省略ヘッダをパースできる", () => {
    const m = "@@ -1 +1 @@".match(hunkHeaderRe);
    assert.ok(m);
    assert.equal(m[1], "1");
    assert.equal(m[3], "1");
  });

  test("resolveAnchor: コメント削除(2行→1行)は範囲 startLine..line を返す", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor(
      {
        path,
        existingCode:
          "// このコメントは自明なので削除したい\nexport function target() {}",
      },
      files
    );
    assert.equal(r.resolved, true);
    assert.equal(r.side, "new");
    assert.deepEqual(r.params, {
      startLine: 3,
      line: 4,
      startSide: "RIGHT",
      side: "RIGHT",
      subjectType: "LINE",
    });
  });

  test("resolveAnchor: 単一行アンカーは line と side のみ（startLine なし）", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor({ path, existingCode: "const UNIQUE_MARKER = 1;" }, files);
    assert.equal(r.resolved, true);
    assert.deepEqual(r.params, { line: 5, side: "RIGHT", subjectType: "LINE" });
  });

  test("正規化: インデント差・diff マーカー付き入力でも一致する", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor(
      { path, existingCode: "+   export function target() {}" },
      files
    );
    assert.equal(r.resolved, true);
    assert.equal(r.params.line, 4);
    assert.equal(r.params.subjectType, "LINE");
  });

  test("resolveAnchor: 不一致の existingCode は resolved:false", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor(
      { path, existingCode: "export function nonexistent() {}" },
      files
    );
    assert.equal(r.resolved, false);
    assert.match(r.reason, /一致/);
  });

  test("resolveAnchor: 複数一致（曖昧）は resolved:false", () => {
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
    const r = resolveAnchor({ path: "src/dup.js", existingCode: "dup" }, files);
    assert.equal(r.resolved, false);
  });

  test("resolveAnchor: 差分にないファイルは resolved:false", () => {
    const files = parseDiff(buildDiff());
    const r = resolveAnchor({ path: "src/other.js", existingCode: "anything" }, files);
    assert.equal(r.resolved, false);
    assert.match(r.reason, /差分が見つからない/);
  });

  test("resolveAnchor: 削除行(old側)にもマッチする", () => {
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
    const r = resolveAnchor({ path: "src/edit.js", existingCode: "removed_line" }, files);
    assert.equal(r.resolved, true);
    assert.equal(r.side, "old");
    assert.equal(r.params.line, 11);
    assert.equal(r.params.side, "LEFT");
  });

  test("非ASCIIパス: quotepath=false の生UTF-8 diff で行番号を解決できる", () => {
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
    const r = resolveAnchor({ path: nonAsciiPath, existingCode: "# 見出し" }, files);
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
