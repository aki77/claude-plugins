#!/usr/bin/env node
// PR レビュー（サマリ + インラインコメント）を GitHub REST API で1リクエスト投稿する。
//
// 背景: GitHub REST API の `POST /pulls/{n}/reviews` は comments 配列を含めて1リクエストで
// レビュー全体を投稿できる。行番号は FINAL 成果物（apply-verdicts.mjs の出力）が持つ params
// をそのまま使う（LLM に推測させない・触らせない）。LLM は `{id, body}` だけを渡す。
//
// 設計（決定論化）: LLM は params に一切触れない。FINAL の各 confirmed issue には既に
// `resolved` / `params` / `path` が確定しているので、このスクリプトが `id` で突き合わせて
// params を結合する。LLM は「どの issue に」「どんな本文を」だけを `{id, body}` で指定する。
//
// 入力:
//   引数 --pr <PR>       : 対象 PR。
//   引数 --commit <sha>  : レビュー対象コミット（ステップ0で取得済みの headRefOid）。
//                          レビュー対象を固定し、最新化ズレでの位置解決失敗を防ぐ。
//   引数 --issues <FINAL>: apply-verdicts.mjs が書いた FINAL ファイルのパス。confirmed issue の
//                          id / path / resolved / params を持つ。
//   stdin (JSON): { summaryBody, comments: [{ id, body }] }
//                   summaryBody : レビュー全体のサマリ本文。
//                   comments    : インライン投稿する issue の {id, body} 配列。
//                     id        : FINAL の confirmed issue の id（= groupId）。
//                     body      : commentBody + 必要に応じ suggestion ブロックの最終形。
// 出力(stdout): 投稿されたレビューの html_url。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fail, parseFlags, readArtifact, readStdinJson } from "./lib/artifact.mjs";

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

// stdin の入力（{summaryBody, comments:[{id,body}]}）と FINAL（confirmed issue 群）を
// 突き合わせて REST API のリクエストボディへ変換する純粋関数。
// 不正な入力（未知/重複 id・resolved:false のインライン化・resolved:true confirmed の黙殺・
// body 空）は Error を投げて呼び出し側で即失敗させる。
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
    if (typeof c.body !== "string" || c.body.trim() === "") {
      throw new Error(`comments[${i}] の id=${c.id} は body が空です`);
    }
    restComments.push(toComment(issue, c.body));
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
  const { pr, commit, issues } = parseFlags(process.argv, {
    flags: ["--pr", "--commit", "--issues"],
    required: ["--pr", "--commit", "--issues"],
    usage: "post-review.mjs --pr <PR> --commit <sha> --issues <FINAL>  (投稿内容 JSON を stdin で渡す)",
  });

  let input;
  try {
    input = readStdinJson();
  } catch (e) {
    fail(`stdin の JSON パースに失敗しました: ${e.message}`);
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

  const finalDoc = {
    issues: [
      { id: "g1", path: "src/a.js", resolved: true, params: { line: 10, side: "RIGHT", subjectType: "LINE" } },
      { id: "g2", path: "src/b.js", resolved: true, params: { startLine: 3, line: 4, startSide: "RIGHT", side: "RIGHT", subjectType: "LINE" } },
      { id: "g3", path: "src/c.js", resolved: false, reason: "不一致" },
    ],
  };

  test("buildPayload: 基本形（commit_id / event / body）を組み立てる", () => {
    // resolved:true が g1,g2。両方 comments に含めないと黙殺エラーになるため両方渡す。
    const p = buildPayload(
      { summaryBody: "## サマリ", comments: [{ id: "g1", body: "問題1" }, { id: "g2", body: "問題2" }] },
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
      { summaryBody: "s", comments: [{ id: "g1", body: "x" }, { id: "g2", body: "y" }] },
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
      { summaryBody: "s", comments: [{ id: "g1", body: "x" }, { id: "g2", body: "y" }] },
      finalDoc,
      { commitId: "x" }
    );
    const c2 = p.comments.find((c) => c.path === "src/b.js");
    assert.deepEqual(c2, { path: "src/b.js", body: "y", line: 4, side: "RIGHT", start_line: 3, start_side: "RIGHT" });
  });

  test("suggestion ブロックを含む body をそのまま保持する", () => {
    const body = "提案\n```suggestion\nfoo\n```";
    const p = buildPayload(
      { summaryBody: "s", comments: [{ id: "g1", body: "x" }, { id: "g2", body }] },
      finalDoc,
      { commitId: "x" }
    );
    assert.equal(p.comments.find((c) => c.path === "src/b.js").body, body);
  });

  test("検証: comments が配列でなければ throw", () => {
    assert.throws(() => buildPayload({ summaryBody: "s" }, finalDoc, { commitId: "x" }), /comments は配列/);
  });

  test("検証: 未知 id は throw", () => {
    assert.throws(
      () => buildPayload({ summaryBody: "s", comments: [{ id: "g99", body: "x" }] }, finalDoc, { commitId: "x" }),
      /存在しません/
    );
  });

  test("検証: 重複 id は throw", () => {
    assert.throws(
      () =>
        buildPayload(
          { summaryBody: "s", comments: [{ id: "g1", body: "x" }, { id: "g1", body: "y" }, { id: "g2", body: "z" }] },
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
          { summaryBody: "s", comments: [{ id: "g1", body: "x" }, { id: "g2", body: "y" }, { id: "g3", body: "z" }] },
          finalDoc,
          { commitId: "x" }
        ),
      /インライン投稿できません/
    );
  });

  test("検証: resolved:true confirmed の黙殺（comments 欠落）は throw", () => {
    // g2 を渡し忘れ → 黙殺防止で throw。
    assert.throws(
      () => buildPayload({ summaryBody: "s", comments: [{ id: "g1", body: "x" }] }, finalDoc, { commitId: "x" }),
      /黙殺防止/
    );
  });

  test("検証: body 空は throw", () => {
    assert.throws(
      () =>
        buildPayload(
          { summaryBody: "s", comments: [{ id: "g1", body: "  " }, { id: "g2", body: "y" }] },
          finalDoc,
          { commitId: "x" }
        ),
      /body が空/
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
