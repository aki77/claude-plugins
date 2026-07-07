#!/usr/bin/env node
import { fileURLToPath } from "node:url";

// トランスクリプトの各行を JSON.parse する。壊れた行があっても丸ごと落とさず、
// その行だけ obj: null として保持する（後続処理は raw を使えば復元できる）。
export function parseTranscriptLines(rawText) {
  return rawText.split("\n").map((raw, lineIndex) => {
    if (raw.trim() === "") return { lineIndex, raw, obj: null };
    try {
      return { lineIndex, raw, obj: JSON.parse(raw) };
    } catch {
      return { lineIndex, raw, obj: null };
    }
  });
}

// ファイル末尾の改行由来で split("\n") が生む末尾の空要素を数えないための実効行数。
// これを totalLineCount に含めると、次回 slice(totalLineCount) が常に1行分ズレて
// 最新の追記行を見逃し続けるバグになるため、次回の位置ブックマークには使わない。
function effectiveLineCount(parsedLines) {
  let count = parsedLines.length;
  while (count > 0 && parsedLines[count - 1].raw.trim() === "") count--;
  return count;
}

// 前回処理済みの行数(lastProcessedLineCount)より後ろの行だけを取り出す。
// compact_boundary（非公開スキーマ、圧縮完了後にしか存在しない）に依存しない、
// PreCompact 用の差分抽出関数。PreCompact は圧縮処理より前に発火するため、
// この時点の transcript は「前回 PreCompact 以降に増えた行」を素直に末尾から取れば十分。
export function extractNewSegment(parsedLines, lastProcessedLineCount) {
  const newLines = parsedLines.slice(lastProcessedLineCount);
  const segmentText = newLines
    .map(({ raw }) => raw)
    .filter((raw) => raw.trim() !== "")
    .join("\n");

  return {
    segmentText,
    isEmpty: segmentText.trim() === "",
    totalLineCount: effectiveLineCount(parsedLines),
  };
}

// ---- インラインテスト --------------------------------------------------------
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  const line = (obj) => JSON.stringify(obj);
  const userMsg = (text) => line({ type: "user", message: { role: "user", content: text } });

  test("parseTranscriptLines: 正常な行を全てパースする", () => {
    const raw = [userMsg("a"), userMsg("b")].join("\n");
    const parsed = parseTranscriptLines(raw);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].obj.type, "user");
  });

  test("parseTranscriptLines: 壊れた行は obj:null として保持し、他行は落とさない", () => {
    const raw = [userMsg("a"), "{not valid json", userMsg("b")].join("\n");
    const parsed = parseTranscriptLines(raw);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[1].obj, null);
    assert.equal(parsed[1].raw, "{not valid json");
    assert.equal(parsed[2].obj.type, "user");
  });

  test("parseTranscriptLines: 空行は obj:null", () => {
    const parsed = parseTranscriptLines([userMsg("a"), ""].join("\n"));
    assert.equal(parsed[1].obj, null);
  });

  test("extractNewSegment: lastProcessedLineCount=0 は全行を対象にする(初回)", () => {
    const raw = [userMsg("a"), userMsg("b")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const result = extractNewSegment(parsed, 0);
    assert.equal(result.segmentText, raw);
    assert.equal(result.isEmpty, false);
    assert.equal(result.totalLineCount, 2);
  });

  test("extractNewSegment: lastProcessedLineCount より後ろの行だけを対象にする", () => {
    const raw = [userMsg("a"), userMsg("b"), userMsg("c")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const result = extractNewSegment(parsed, 1);
    assert.equal(result.segmentText, [userMsg("b"), userMsg("c")].join("\n"));
    assert.ok(!result.segmentText.includes(userMsg("a")));
  });

  test("extractNewSegment: lastProcessedLineCount が総行数と同じなら isEmpty true", () => {
    const raw = [userMsg("a"), userMsg("b")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const result = extractNewSegment(parsed, parsed.length);
    assert.equal(result.segmentText, "");
    assert.equal(result.isEmpty, true);
  });

  test("extractNewSegment: 区間途中の空行はsegmentTextから除かれるがtotalLineCountには数える", () => {
    const raw = [userMsg("a"), "", userMsg("b")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const result = extractNewSegment(parsed, 0);
    assert.equal(result.segmentText, [userMsg("a"), userMsg("b")].join("\n"));
    assert.equal(result.totalLineCount, 3);
  });

  test("extractNewSegment: totalLineCount は lastProcessedLineCount に関わらず一定", () => {
    const raw = [userMsg("a"), userMsg("b"), userMsg("c")].join("\n");
    const parsed = parseTranscriptLines(raw);
    assert.equal(extractNewSegment(parsed, 0).totalLineCount, 3);
    assert.equal(extractNewSegment(parsed, 2).totalLineCount, 3);
  });

  test("extractNewSegment: ファイル末尾の改行由来の空要素は totalLineCount に含めない(次回の1行取りこぼしバグ回帰防止)", () => {
    // fs.readFileSync + split("\n") は末尾に改行があると常に末尾に空文字列の要素を1つ生む。
    // これを totalLineCount に含めてしまうと、次回 slice(totalLineCount) が1行分ズレて
    // 直後に追記された行を永久に見逃す（実際に発生した回帰）。
    const rawWithTrailingNewline = userMsg("a") + "\n" + userMsg("b") + "\n";
    const parsed = parseTranscriptLines(rawWithTrailingNewline);
    assert.equal(parsed.length, 3); // 実データ2行 + 末尾空要素1個
    const result = extractNewSegment(parsed, 0);
    assert.equal(result.totalLineCount, 2);

    // 次回、1行だけ追記された状態を模す。
    const appended = rawWithTrailingNewline + userMsg("c") + "\n";
    const parsedNext = parseTranscriptLines(appended);
    const nextResult = extractNewSegment(parsedNext, result.totalLineCount);
    assert.equal(nextResult.isEmpty, false);
    assert.equal(nextResult.segmentText, userMsg("c"));
  });
}
