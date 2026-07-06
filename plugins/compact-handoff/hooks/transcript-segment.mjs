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

// compact_boundary 行（圧縮が実行された境界を示すシステム行）を行順に列挙する。
export function findCompactBoundaries(parsedLines) {
  return parsedLines
    .filter(({ obj }) => obj?.type === "system" && obj?.subtype === "compact_boundary")
    .map(({ lineIndex, obj }) => ({ lineIndex, obj }));
}

// 直近の圧縮で捨てられた生ログ区間を取り出す。
// 境界が無ければ null（このフックは何もすべきではない）。
// 直前の境界（あれば）の次行 〜 最新境界の前行までを対象とし、境界行自体（メタデータ）は除外する。
export function extractLatestSegment(parsedLines) {
  const boundaries = findCompactBoundaries(parsedLines);
  if (boundaries.length === 0) return null;

  const latestBoundary = boundaries[boundaries.length - 1];
  const previousBoundary = boundaries.length >= 2 ? boundaries[boundaries.length - 2] : null;

  const start = (previousBoundary?.lineIndex ?? -1) + 1;
  const end = latestBoundary.lineIndex;

  const segmentText = parsedLines
    .slice(start, end)
    .map(({ raw }) => raw)
    .filter((raw) => raw.trim() !== "")
    .join("\n");

  return {
    segmentText,
    isEmpty: segmentText.trim() === "",
    latestBoundary,
    previousBoundary,
  };
}

// 最新境界のuuidが lastProcessedUuid と同じ（または境界自体が無い）なら、
// 「今回の SessionStart に対応する新しい境界がまだ書き込まれていない」とみなす。
export function isSegmentStale(segment, lastProcessedUuid) {
  if (!segment) return true;
  return segment.latestBoundary.obj.uuid === lastProcessedUuid;
}

// ---- インラインテスト --------------------------------------------------------
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  const line = (obj) => JSON.stringify(obj);
  const boundary = () => line({ type: "system", subtype: "compact_boundary" });
  const userMsg = (text) => line({ type: "user", message: { role: "user", content: text } });

  test("parseTranscriptLines: 正常な行を全てパースする", () => {
    const raw = [userMsg("a"), boundary(), userMsg("b")].join("\n");
    const parsed = parseTranscriptLines(raw);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].obj.type, "user");
    assert.equal(parsed[1].obj.subtype, "compact_boundary");
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

  test("findCompactBoundaries: 境界が無ければ空配列", () => {
    const parsed = parseTranscriptLines([userMsg("a"), userMsg("b")].join("\n"));
    assert.deepEqual(findCompactBoundaries(parsed), []);
  });

  test("findCompactBoundaries: 複数境界を行順で返す", () => {
    const raw = [userMsg("a"), boundary(), userMsg("b"), boundary(), userMsg("c")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const boundaries = findCompactBoundaries(parsed);
    assert.equal(boundaries.length, 2);
    assert.equal(boundaries[0].lineIndex, 1);
    assert.equal(boundaries[1].lineIndex, 3);
  });

  test("extractLatestSegment: 境界が無ければ null", () => {
    const parsed = parseTranscriptLines([userMsg("a"), userMsg("b")].join("\n"));
    assert.equal(extractLatestSegment(parsed), null);
  });

  test("extractLatestSegment: 初回compact(境界1件)はファイル先頭から境界前までを対象にする", () => {
    const raw = [userMsg("a"), userMsg("b"), boundary(), userMsg("c")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const result = extractLatestSegment(parsed);
    assert.equal(result.previousBoundary, null);
    assert.equal(result.segmentText, [userMsg("a"), userMsg("b")].join("\n"));
    assert.equal(result.isEmpty, false);
  });

  test("extractLatestSegment: 2回目以降のcompactは直前境界〜最新境界の差分のみを対象にする", () => {
    const raw = [
      userMsg("a"),
      boundary(),
      userMsg("b"),
      userMsg("c"),
      boundary(),
      userMsg("d"),
    ].join("\n");
    const parsed = parseTranscriptLines(raw);
    const result = extractLatestSegment(parsed);
    assert.equal(result.segmentText, [userMsg("b"), userMsg("c")].join("\n"));
    assert.ok(!result.segmentText.includes(userMsg("a")));
  });

  test("extractLatestSegment: 境界行自体は区間に含めない", () => {
    const raw = [userMsg("a"), boundary()].join("\n");
    const parsed = parseTranscriptLines(raw);
    const result = extractLatestSegment(parsed);
    assert.ok(!result.segmentText.includes("compact_boundary"));
  });

  test("extractLatestSegment: 境界が隣接していて差分が空の場合は isEmpty true", () => {
    const raw = [boundary(), boundary(), userMsg("a")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const result = extractLatestSegment(parsed);
    assert.equal(result.segmentText, "");
    assert.equal(result.isEmpty, true);
  });

  test("extractLatestSegment: 境界がファイル末尾でも正しく動作する", () => {
    const raw = [userMsg("a"), boundary()].join("\n");
    const parsed = parseTranscriptLines(raw);
    const result = extractLatestSegment(parsed);
    assert.equal(result.isEmpty, false);
    assert.equal(result.segmentText, userMsg("a"));
  });

  const boundaryWithUuid = (uuid) =>
    line({ type: "system", subtype: "compact_boundary", uuid });

  test("isSegmentStale: segmentがnull(境界なし)ならstale", () => {
    assert.equal(isSegmentStale(null, "uuid-1"), true);
  });

  test("isSegmentStale: 最新境界のuuidがlastProcessedUuidと同じならstale", () => {
    const raw = [userMsg("a"), boundaryWithUuid("uuid-1")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const segment = extractLatestSegment(parsed);
    assert.equal(isSegmentStale(segment, "uuid-1"), true);
  });

  test("isSegmentStale: 最新境界のuuidがlastProcessedUuidと異なればstaleでない", () => {
    const raw = [userMsg("a"), boundaryWithUuid("uuid-2")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const segment = extractLatestSegment(parsed);
    assert.equal(isSegmentStale(segment, "uuid-1"), false);
  });

  test("isSegmentStale: lastProcessedUuidがnull(未処理)なら常にstaleでない", () => {
    const raw = [userMsg("a"), boundaryWithUuid("uuid-1")].join("\n");
    const parsed = parseTranscriptLines(raw);
    const segment = extractLatestSegment(parsed);
    assert.equal(isSegmentStale(segment, null), false);
  });
}
