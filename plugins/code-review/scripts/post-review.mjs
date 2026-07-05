#!/usr/bin/env node
// PR レビュー（サマリ + インラインコメント）を GitHub REST API で1リクエスト投稿する。
//
// 背景: GitHub REST API の `POST /pulls/{n}/reviews` は comments 配列を含めて1リクエストで
// レビュー全体を投稿できる。行番号は FINAL 成果物（apply-verdicts.mjs の出力）が持つ params
// をそのまま使う（LLM に推測させない・触らせない）。LLM は `{id, body}` だけを渡す。
//
// 設計（決定論化）: LLM は params に一切触れない。FINAL の各 confirmed issue には既に
// `resolved` / `params` / `path` / `existingCode` が確定しているので、このスクリプトが `id` で
// 突き合わせて params を結合する。LLM は「どの issue に」「どんな文章を」「どんな suggestion を」
// だけを `{id, commentBody, suggestion?, deleteLines?}` で指定する。
//
// suggestion の破壊的編集防止（fail-closed）: 投稿される置換範囲は params（startLine..line）で
// 機械確定されるが、suggestion 本文の行数が範囲より短いと GitHub は余った行を削除する（実例:
// gitignore の `apm_modules/` がコメント指摘の巻き添えで消えた）。そこで LLM には ```suggestion
// フェンスを書かせず「置換後の行だけ」を渡させ、このスクリプトが FINAL の existingCode（＝範囲の
// 逐語テキスト）と突き合わせて「意図しない行削除」を機械検出する。検出したら suggestion を捨てて
// 文章コメントのみ投稿する（コードは絶対に消さない・レビュー全体は止めない）。
//
// 入力:
//   引数 --pr <PR>       : 対象 PR。
//   引数 --commit <sha>  : レビュー対象コミット（ステップ0で取得済みの headRefOid）。
//                          レビュー対象を固定し、最新化ズレでの位置解決失敗を防ぐ。
//   引数 --issues <FINAL>: apply-verdicts.mjs が書いた FINAL ファイルのパス。confirmed issue の
//                          id / path / resolved / params / existingCode / sourceFindingIds を持つ。
//   stdin (JSON): { summaryBody, comments: [{ id, commentBody, suggestion?, deleteLines? }] }
//                   summaryBody : レビュー全体のサマリ本文。
//                   comments    : インライン投稿する issue の配列。
//                     id          : FINAL の confirmed issue の id（= groupId）。
//                     commentBody : 課題の概要・引用元リンク（suggestion フェンスを含めない）。
//                     suggestion? : 置換後の行（string[] または改行区切り文字列）。省略可。
//                                   スクリプトが ```suggestion フェンスで包んで commentBody に続ける。
//                     deleteLines?: suggestion で削除してよい既存行の配列（正規化一致で判定）。
//                                   行削除を伴う suggestion はこの明示が無いと機械ガードが捨てる。
// 出力(stdout): 投稿されたレビューの html_url。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fail, parseFlags, readArtifact, readSingleInputJson } from "./lib/artifact.mjs";
import { splitAndNormalize } from "./lib/diff-anchor.mjs";

// ---- ペイロード生成 ----------------------------------------------------------
// FINAL の issue（params 付き）と LLM の body を REST API の comment フィールド（snake_case）へ
// 変換する。単一行は line+side のみ、複数行は start_line/start_side も含む。subjectType は落とす。
function toComment(issue, body) {
  const { line, startLine, side, startSide } = issue.params;
  const comment = { path: issue.path, body, line };
  if (side != null) comment.side = side;
  if (startLine != null) comment.start_line = startLine;
  if (startSide != null) comment.start_side = startSide;
  return comment;
}

// suggestion 入力を行配列へ正規化する（string[] / 改行区切り文字列の両方を受ける）。
// 末尾の空行は落とすが、途中の空行は保持する（コードの一部になりうるため）。
function toSuggestionLines(suggestion) {
  const arr = Array.isArray(suggestion) ? suggestion : String(suggestion).split("\n");
  const lines = arr.map((l) => String(l));
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

// params の範囲行数を返す（単一行なら1、複数行なら line - startLine + 1）。
function rangeLineCount(params) {
  const end = params.line;
  const start = params.startLine ?? end;
  return Math.abs(end - start) + 1;
}

// suggestion を機械検証し、安全なら ```suggestion フェンス付き本文を、危険なら null を返す
// （呼び出し側は null なら suggestion を捨てて commentBody のみ投稿する = fail-closed）。
//
// 破壊の本質: GitHub は params の範囲（rangeLineCount 行）を suggestion 本文（sugCount 行）で
// 丸ごと置換する。コード消失が起きるのは sugCount < rangeLineCount のとき「だけ」。行数が同じ
// 編集（2→2, 1→1）や増える編集（1→3）は、内容が変わっても既存行の巻き添え削除は起きない。
// よって行削除（sugCount < rangeLineCount）のときだけ deleteLines での明示を要求すればよい。
//
// 判定（issue は resolved:true 前提。呼び出し側で担保）:
//   1. 複数メンバーグループ（sourceFindingIds.length >= 2）→ existingCode が範囲全体を表さない
//      ため null（安全側）。
//   2. params の範囲行数 ≠ existingCode の行数 → 範囲とアンカーがズレている → null。
//   3. 行削除（sugCount < rangeLineCount）が起きる場合のみ、削減分（shortfall = 範囲行数 -
//      suggestion 行数）だけ deleteLines で消える行を明示させる。消える行（existingCode のうち
//      suggestion に残らない行）がすべて deleteLines に含まれ、その数が shortfall と一致すれば許可。
//      deleteLines 無し／不足なら null（今回の gitignore 事故ケースはここで確実に弾かれる）。
// 戻り値: { ok:true, body } / { ok:false, reason }
export function buildSuggestionBody(issue, suggestion, deleteLines) {
  if (Array.isArray(issue.sourceFindingIds) && issue.sourceFindingIds.length >= 2) {
    return { ok: false, reason: "複数メンバーの統合 issue には suggestion を付けられません（アンカーが範囲全体を表さない）" };
  }
  const existingLines = splitAndNormalize(issue.existingCode ?? "");
  if (existingLines.length === 0) {
    return { ok: false, reason: "existingCode が空で suggestion を検証できません" };
  }
  // 範囲行数と existingCode 行数の一致確認。singleton では resolveAnchor が
  // splitAndNormalize(existingCode) を diff にマッチさせて params を作るため、通常この2つは
  // 一致する。ここは resolveAnchor の不変条件を投稿直前に念のため確認する fail-closed の防波堤。
  if (rangeLineCount(issue.params) !== existingLines.length) {
    return { ok: false, reason: "params の範囲行数と existingCode の行数が一致しません" };
  }

  const sugLines = toSuggestionLines(suggestion);
  const sugNormLines = splitAndNormalize(sugLines.join("\n"));
  const shortfall = existingLines.length - sugNormLines.length;

  if (shortfall > 0) {
    // 行削除が起きる。消える行（既存行のうち suggestion 正規化集合に無いもの）を deleteLines で
    // 明示していないと危険なので捨てる。
    const sugNorm = new Set(sugNormLines);
    const deleteSet = new Set(splitAndNormalize((deleteLines ?? []).join("\n")));
    const vanishing = existingLines.filter((l) => !sugNorm.has(l));
    const unexpected = vanishing.filter((l) => !deleteSet.has(l));
    if (unexpected.length > 0) {
      return {
        ok: false,
        reason: `suggestion が既存行を削除しますが deleteLines で明示されていません: ${unexpected.join(" / ")}`,
      };
    }
    // 明示された削除行数が実際の削減行数と一致すること（消し過ぎ・行ズレの検出）。
    if (vanishing.length !== shortfall) {
      return {
        ok: false,
        reason: `削除行数（${vanishing.length}）が範囲と suggestion の行数差（${shortfall}）と一致しません`,
      };
    }
  }

  const body = ["```suggestion", ...sugLines, "```"].join("\n");
  return { ok: true, body };
}

// commentBody に「suggestion を機械判定で捨てた」注記を付ける（body が空にならないようにもする）。
function withStrippedNote(commentBody, reason) {
  const note = `\n\n（自動判定: suggestion がアンカー範囲と不整合のため本文のみ投稿しました。理由: ${reason}）`;
  return `${(commentBody ?? "").trimEnd()}${note}`.trim();
}

// stdin の入力（{summaryBody, comments:[{id,commentBody,suggestion?,deleteLines?}]}）と
// FINAL（confirmed issue 群）を突き合わせて REST API のリクエストボディへ変換する純粋関数。
// 不正な入力（未知/重複 id・resolved:false のインライン化・resolved:true confirmed の黙殺・
// commentBody 空）は Error を投げて呼び出し側で即失敗させる。suggestion の危険は例外にせず
// fail-closed で捨てる（コードを消さない・レビューを止めない）。
export function buildPayload(input, finalDoc, { commitId }) {
  if (!input || typeof input !== "object") {
    throw new Error("入力 JSON はオブジェクトである必要があります");
  }
  const comments = input.comments;
  if (!Array.isArray(comments)) {
    throw new Error("comments は配列である必要があります（[{id, body}] を渡してください）");
  }

  const issues = finalDoc.issues ?? [];
  const issueById = new Map(issues.map((i) => [i.id, i]));
  // インライン投稿できる（=行番号が確定している）confirmed issue の集合。
  const resolvedIds = new Set(issues.filter((i) => i.resolved).map((i) => i.id));

  const restComments = [];
  const seen = new Set();
  comments.forEach((c, i) => {
    if (!c || typeof c.id !== "string") {
      throw new Error(`comments[${i}] は id（文字列）を持つ必要があります`);
    }
    const issue = issueById.get(c.id);
    if (!issue) {
      throw new Error(`comments[${i}] の id=${c.id} は FINAL の confirmed issue に存在しません`);
    }
    if (seen.has(c.id)) {
      throw new Error(`comments[${i}] の id=${c.id} が重複しています`);
    }
    seen.add(c.id);
    if (!issue.resolved) {
      // 行番号が確定していない issue はインライン化できない（誤位置に貼らない）。
      throw new Error(
        `comments[${i}] の id=${c.id} は resolved:false（行番号未確定）のためインライン投稿できません。サマリ本文で言及してください`
      );
    }
    if (typeof c.commentBody !== "string" || c.commentBody.trim() === "") {
      throw new Error(`comments[${i}] の id=${c.id} は commentBody が空です`);
    }

    // suggestion があれば機械検証してフェンス結合。危険なら fail-closed で捨てて文章のみ。
    let body = c.commentBody;
    if (c.suggestion != null) {
      const r = buildSuggestionBody(issue, c.suggestion, c.deleteLines);
      body = r.ok ? `${c.commentBody.trimEnd()}\n\n${r.body}` : withStrippedNote(c.commentBody, r.reason);
    }
    restComments.push(toComment(issue, body));
  });

  // 黙殺防止: インライン投稿可能（resolved:true）な confirmed issue が comments に無いのは
  // 課題が黙って消えるサイレント失敗。投稿前に必ず弾く。resolved 済み issue が0件なら
  // サマリのみ投稿を許容する（課題ゼロ投稿の現行仕様を維持）。
  for (const id of resolvedIds) {
    if (!seen.has(id)) {
      throw new Error(
        `confirmed issue id=${id} は resolved:true ですが comments に含まれていません（黙殺防止）。body を付けて渡すか、対応を見直してください`
      );
    }
  }

  return {
    commit_id: commitId,
    event: "COMMENT",
    body: input.summaryBody ?? "",
    comments: restComments,
  };
}

// ---- main --------------------------------------------------------------------
if (!process.env.NODE_TEST_CONTEXT) {
  const { pr, commit, issues, infile } = parseFlags(process.argv, {
    flags: ["--pr", "--commit", "--issues", "--infile"],
    required: ["--pr", "--commit", "--issues"],
    multi: ["--infile"],
    usage:
      "post-review.mjs --pr <PR> --commit <sha> --issues <FINAL> --infile <payload.json>  (投稿内容 JSON。--infile 省略時は stdin)",
  });

  let input;
  try {
    input = readSingleInputJson(infile);
  } catch (e) {
    fail(`入力 JSON のパースに失敗しました: ${e.message}`);
  }

  let finalDoc;
  try {
    finalDoc = readArtifact(issues);
  } catch (e) {
    fail(e.message);
  }

  let payload;
  try {
    payload = buildPayload(input, finalDoc, { commitId: commit });
  } catch (e) {
    fail(e.message);
  }

  // gh の {owner}/{repo} プレースホルダ置換に任せ、対象リポジトリを自動解決する。
  const stdout = execFileSync(
    "gh",
    ["api", "--method", "POST", `/repos/{owner}/{repo}/pulls/${pr}/reviews`, "--input", "-"],
    { input: JSON.stringify(payload), encoding: "utf8" }
  );

  let htmlUrl = "";
  try {
    htmlUrl = JSON.parse(stdout).html_url ?? "";
  } catch {
    // レスポンスが JSON でない場合はそのまま表示にフォールバック。
  }
  console.log(htmlUrl || stdout);
}

// ---- インラインテスト --------------------------------------------------------
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  // g1: 単一行 singleton（existingCode 1行）。g2: 2行 singleton（existingCode 2行）。
  // g3: resolved:false。
  const finalDoc = {
    issues: [
      { id: "g1", path: "src/a.js", resolved: true, existingCode: "const x = 1;", sourceFindingIds: ["f1"], params: { line: 10, side: "RIGHT", subjectType: "LINE" } },
      { id: "g2", path: "src/b.js", resolved: true, existingCode: "# APM dependencies\napm_modules/", sourceFindingIds: ["f2"], params: { startLine: 3, line: 4, startSide: "RIGHT", side: "RIGHT", subjectType: "LINE" } },
      { id: "g3", path: "src/c.js", resolved: false, reason: "不一致" },
    ],
  };

  test("buildPayload: 基本形（commit_id / event / body）を組み立てる", () => {
    // resolved:true が g1,g2。両方 comments に含めないと黙殺エラーになるため両方渡す。
    const p = buildPayload(
      { summaryBody: "## サマリ", comments: [{ id: "g1", commentBody: "問題1" }, { id: "g2", commentBody: "問題2" }] },
      finalDoc,
      { commitId: "abc123" }
    );
    assert.equal(p.commit_id, "abc123");
    assert.equal(p.event, "COMMENT");
    assert.equal(p.body, "## サマリ");
    assert.equal(p.comments.length, 2);
  });

  test("toComment: 単一行は line+side のみ、start_*/subjectType を含めない", () => {
    const p = buildPayload(
      { summaryBody: "s", comments: [{ id: "g1", commentBody: "x" }, { id: "g2", commentBody: "y" }] },
      finalDoc,
      { commitId: "x" }
    );
    const c1 = p.comments.find((c) => c.path === "src/a.js");
    assert.deepEqual(c1, { path: "src/a.js", body: "x", line: 10, side: "RIGHT" });
    assert.ok(!("start_line" in c1));
    assert.ok(!("subjectType" in c1));
  });

  test("toComment: 複数行は start_line/start_side を snake_case に変換する", () => {
    const p = buildPayload(
      { summaryBody: "s", comments: [{ id: "g1", commentBody: "x" }, { id: "g2", commentBody: "y" }] },
      finalDoc,
      { commitId: "x" }
    );
    const c2 = p.comments.find((c) => c.path === "src/b.js");
    assert.deepEqual(c2, { path: "src/b.js", body: "y", line: 4, side: "RIGHT", start_line: 3, start_side: "RIGHT" });
  });

  test("suggestion 無しは commentBody をそのまま body にする", () => {
    const p = buildPayload(
      { summaryBody: "s", comments: [{ id: "g1", commentBody: "文章のみ" }, { id: "g2", commentBody: "y" }] },
      finalDoc,
      { commitId: "x" }
    );
    assert.equal(p.comments.find((c) => c.path === "src/a.js").body, "文章のみ");
  });

  test("suggestion: 行数一致（単一行 singleton）は ```suggestion ブロックで結合する", () => {
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "提案", suggestion: "const x = 2;" },
          { id: "g2", commentBody: "y" },
        ],
      },
      finalDoc,
      { commitId: "x" }
    );
    assert.equal(
      p.comments.find((c) => c.path === "src/a.js").body,
      "提案\n\n```suggestion\nconst x = 2;\n```"
    );
  });

  test("回帰（gitignore 事故）: 2行範囲×1行 suggestion×deleteLines 無し → suggestion を捨て文章のみ・コード非削除", () => {
    // existingCode = "# APM dependencies\napm_modules/"（2行）。suggestion を翻訳コメント1行にすると
    // apm_modules/ が消える。deleteLines 無しなので機械ガードが suggestion を捨てる。
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "x" },
          { id: "g2", commentBody: "コメントは日本語で", suggestion: "# APMパッケージ依存" },
        ],
      },
      finalDoc,
      { commitId: "x" }
    );
    const c2 = p.comments.find((c) => c.path === "src/b.js");
    assert.ok(!c2.body.includes("```suggestion"), "破壊的 suggestion は投稿されない");
    assert.ok(!c2.body.includes("apm_modules/ を消"), "本文にコード削除は起きない");
    assert.match(c2.body, /自動判定/);
    assert.ok(c2.body.trim().length > 0, "body は空でない");
  });

  test("suggestion: deleteLines で削除を明示すれば行削除 suggestion も投稿する", () => {
    // apm_modules/ は残し、# APM dependencies を翻訳（＝行数維持）ではなく、コメント行を削除して
    // apm_modules/ だけ残すケースを deleteLines で明示。
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "x" },
          {
            id: "g2",
            commentBody: "不要コメント削除",
            suggestion: "apm_modules/",
            deleteLines: ["# APM dependencies"],
          },
        ],
      },
      finalDoc,
      { commitId: "x" }
    );
    assert.equal(
      p.comments.find((c) => c.path === "src/b.js").body,
      "不要コメント削除\n\n```suggestion\napm_modules/\n```"
    );
  });

  test("suggestion: deleteLines に無い行が消えるなら捨てる", () => {
    // apm_modules/ を消しているが deleteLines には # APM dependencies しか無い → 捨てる。
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          { id: "g1", commentBody: "x" },
          {
            id: "g2",
            commentBody: "コメント翻訳",
            suggestion: "# APMパッケージ依存",
            deleteLines: ["# APM dependencies"],
          },
        ],
      },
      finalDoc,
      { commitId: "x" }
    );
    const c2 = p.comments.find((c) => c.path === "src/b.js");
    assert.ok(!c2.body.includes("```suggestion"));
    assert.match(c2.body, /自動判定/);
  });

  test("suggestion: 複数メンバーの統合 issue には付けず捨てる", () => {
    const merged = {
      issues: [
        { id: "g1", path: "src/a.js", resolved: true, existingCode: "const x = 1;", sourceFindingIds: ["f1", "f2"], params: { line: 10, side: "RIGHT", subjectType: "LINE" } },
      ],
    };
    const p = buildPayload(
      { summaryBody: "s", comments: [{ id: "g1", commentBody: "統合課題", suggestion: "const x = 2;" }] },
      merged,
      { commitId: "x" }
    );
    const c1 = p.comments.find((c) => c.path === "src/a.js");
    assert.ok(!c1.body.includes("```suggestion"));
    assert.match(c1.body, /統合/);
  });

  test("buildSuggestionBody: 範囲行数と existingCode 行数の不一致は捨てる", () => {
    const issue = { existingCode: "a\nb\nc", sourceFindingIds: ["f1"], params: { startLine: 1, line: 2, side: "RIGHT" } };
    const r = buildSuggestionBody(issue, "a\nb", []);
    assert.equal(r.ok, false);
    assert.match(r.reason, /範囲行数/);
  });

  test("検証: comments が配列でなければ throw", () => {
    assert.throws(() => buildPayload({ summaryBody: "s" }, finalDoc, { commitId: "x" }), /comments は配列/);
  });

  test("検証: 未知 id は throw", () => {
    assert.throws(
      () => buildPayload({ summaryBody: "s", comments: [{ id: "g99", commentBody: "x" }] }, finalDoc, { commitId: "x" }),
      /存在しません/
    );
  });

  test("検証: 重複 id は throw", () => {
    assert.throws(
      () =>
        buildPayload(
          { summaryBody: "s", comments: [{ id: "g1", commentBody: "x" }, { id: "g1", commentBody: "y" }, { id: "g2", commentBody: "z" }] },
          finalDoc,
          { commitId: "x" }
        ),
      /重複/
    );
  });

  test("検証: resolved:false の id を comments に入れると throw", () => {
    assert.throws(
      () =>
        buildPayload(
          { summaryBody: "s", comments: [{ id: "g1", commentBody: "x" }, { id: "g2", commentBody: "y" }, { id: "g3", commentBody: "z" }] },
          finalDoc,
          { commitId: "x" }
        ),
      /インライン投稿できません/
    );
  });

  test("検証: resolved:true confirmed の黙殺（comments 欠落）は throw", () => {
    // g2 を渡し忘れ → 黙殺防止で throw。
    assert.throws(
      () => buildPayload({ summaryBody: "s", comments: [{ id: "g1", commentBody: "x" }] }, finalDoc, { commitId: "x" }),
      /黙殺防止/
    );
  });

  test("検証: commentBody 空は throw", () => {
    assert.throws(
      () =>
        buildPayload(
          { summaryBody: "s", comments: [{ id: "g1", commentBody: "  " }, { id: "g2", commentBody: "y" }] },
          finalDoc,
          { commitId: "x" }
        ),
      /commentBody が空/
    );
  });

  test("許容: resolved 済み issue 0 件ならサマリのみ投稿（課題ゼロ）", () => {
    const emptyFinal = { issues: [{ id: "g3", path: "c.js", resolved: false }] };
    const p = buildPayload(
      { summaryBody: "問題は見つかりませんでした。", comments: [] },
      emptyFinal,
      { commitId: "x" }
    );
    assert.deepEqual(p.comments, []);
    assert.equal(p.body, "問題は見つかりませんでした。");
  });

  test("許容: confirmed 0 件（FINAL 空）ならサマリのみ投稿", () => {
    const p = buildPayload({ summaryBody: "課題なし", comments: [] }, { issues: [] }, { commitId: "x" });
    assert.deepEqual(p.comments, []);
  });
}
