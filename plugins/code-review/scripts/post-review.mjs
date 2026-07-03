#!/usr/bin/env node
// PR レビュー（サマリ + インラインコメント）を GitHub REST API で1リクエスト投稿する。
//
// 背景: 以前は github mcp の「pending 作成 → コメント逐次追加 → submit」の3段階で
// 投稿していたが、GitHub REST API の `POST /pulls/{n}/reviews` は comments 配列を
// 含めて1リクエストでレビュー全体を投稿できる。gh CLI に一本化するため、mcp を
// この `gh api` 呼び出しに置き換える。行番号は resolve-suggestion-lines.mjs が
// diff から機械的に確定した params をそのまま使う（LLM に推測させない）。
//
// エージェントの JSON 構造ミス対策:
//   入力は resolve-suggestion-lines.mjs の出力（{path, resolved, params, reason}）に
//   body を付与しただけの配列とする。エージェントは REST フィールドへの並べ替えを
//   せず「resolve 出力に body を足すだけ」でよいので、構造ミスの余地を減らす。加えて
//   buildPayload で厳格に検証し、不正な入力（params/body 欠落、resolved:true が
//   あるのに全件弾かれてコメント0件になるサイレント失敗）を明確なエラーで即失敗させる。
//
// 入力:
//   引数 --pr <PR>       : 対象 PR。
//   引数 --commit <sha>  : レビュー対象コミット（ステップ0で取得済みの headRefOid）。
//                          レビュー対象を固定し、最新化ズレでの位置解決失敗を防ぐ。
//   stdin (JSON): { summaryBody, comments: [{ path, resolved, params?, reason?, body? }] }
//                   summaryBody : レビュー全体のサマリ本文。
//                   comments    : resolve 出力そのまま + body を付与した配列（同順マージ）。
//                                 resolved:false の要素を含めてよい（自動スキップ）。
//                     path      : 対象ファイルの相対パス。
//                     resolved  : resolve が行番号確定に成功したか。
//                     params    : resolved:true のとき { line, startLine?, side?, startSide?, subjectType }。
//                     body      : commentBody + 必要に応じ suggestion ブロックの最終形（resolved:true に必須）。
// 出力(stdout): 投稿されたレビューの html_url。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ---- 引数パース --------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pr" && args[i + 1]) out.pr = args[++i];
    else if (args[i] === "--commit" && args[i + 1]) out.commit = args[++i];
  }
  if (!out.pr || !out.commit) {
    console.error(
      "Usage: post-review.mjs --pr <PR> --commit <sha>  (投稿内容 JSON を stdin で渡す)"
    );
    process.exit(1);
  }
  return out;
}

// stdin（fd 0）を同期で最後まで読む。パイプ・リダイレクト双方で動く。
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ---- ペイロード生成 ----------------------------------------------------------
// resolve 出力 1 要素（+body）を REST API の comment フィールド（snake_case）へ変換する。
// 単一行は line+side のみ、複数行は start_line/start_side も含む。subjectType は落とす。
function toComment(item) {
  const { line, startLine, side, startSide } = item.params;
  const comment = { path: item.path, body: item.body, line };
  if (side != null) comment.side = side;
  if (startLine != null) comment.start_line = startLine;
  if (startSide != null) comment.start_side = startSide;
  return comment;
}

// stdin の入力を検証・フィルタしつつ REST API のリクエストボディへ変換する。
// 不正な入力（構造ミス・サイレント失敗）は Error を投げて呼び出し側で即失敗させる。
function buildPayload(input, { commitId }) {
  if (!input || typeof input !== "object") {
    throw new Error("入力 JSON はオブジェクトである必要があります");
  }
  const comments = input.comments;
  if (!Array.isArray(comments)) {
    // 典型ミス: comments を渡し忘れ resolve 生出力をトップレベルに置く / summaryBody だけ渡す。
    throw new Error(
      "comments は配列である必要があります（resolve 出力に body を付与した配列を渡してください）"
    );
  }

  // resolved:true の各要素を検証しつつ REST コメントへ変換する。resolved:true には
  // 行番号(params.line)と body が必須で、欠落＝構造ミスとして即座に弾く。この個別検証が
  // サイレント失敗（コメントが黙って消える）を投稿前に確実に止める防御になっている。
  const restComments = [];
  comments.forEach((item, i) => {
    // resolved:false / 未指定 はインライン化しない（サマリ本文で言及される想定）。
    if (!item || item.resolved !== true) return;
    if (!item.params || typeof item.params.line !== "number") {
      throw new Error(
        `comments[${i}] (path=${item.path ?? "?"}) は resolved:true ですが params.line がありません。resolve 出力の params をそのまま渡してください`
      );
    }
    if (typeof item.body !== "string" || item.body.trim() === "") {
      throw new Error(
        `comments[${i}] (path=${item.path ?? "?"}) は resolved:true ですが body が空です`
      );
    }
    restComments.push(toComment(item));
  });

  return {
    commit_id: commitId,
    event: "COMMENT",
    body: input.summaryBody ?? "",
    comments: restComments,
  };
}

// ---- main --------------------------------------------------------------------
if (!process.env.NODE_TEST_CONTEXT) {
  const { pr, commit } = parseArgs(process.argv);

  let input;
  try {
    input = JSON.parse(readStdin());
  } catch (e) {
    console.error(`Error: stdin の JSON パースに失敗しました: ${e.message}`);
    process.exit(1);
  }

  let payload;
  try {
    payload = buildPayload(input, { commitId: commit });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  // gh の {owner}/{repo} プレースホルダ置換に任せ、対象リポジトリを自動解決する。
  const stdout = execFileSync(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `/repos/{owner}/{repo}/pulls/${pr}/reviews`,
      "--input",
      "-",
    ],
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
// `node --test plugins/code-review/scripts/post-review.mjs` で実行する。
// FS/ネットワーク非依存の純粋ロジック（検証・フィルタ・params→REST 変換）を検証する。
if (process.env.NODE_TEST_CONTEXT) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  const single = {
    path: "src/a.js",
    resolved: true,
    body: "問題です",
    params: { line: 10, side: "RIGHT", subjectType: "LINE" },
  };
  const multi = {
    path: "src/b.js",
    resolved: true,
    body: "範囲コメント",
    params: {
      startLine: 3,
      line: 4,
      startSide: "RIGHT",
      side: "RIGHT",
      subjectType: "LINE",
    },
  };

  test("buildPayload: 基本形（commit_id / event / body）を組み立てる", () => {
    const p = buildPayload(
      { summaryBody: "## 変更概要\nfoo", comments: [] },
      { commitId: "abc123" }
    );
    assert.equal(p.commit_id, "abc123");
    assert.equal(p.event, "COMMENT");
    assert.equal(p.body, "## 変更概要\nfoo");
    assert.deepEqual(p.comments, []);
  });

  test("toComment: 単一行は line+side のみ、start_*/subjectType を含めない", () => {
    const p = buildPayload({ summaryBody: "s", comments: [single] }, { commitId: "x" });
    assert.deepEqual(p.comments[0], {
      path: "src/a.js",
      body: "問題です",
      line: 10,
      side: "RIGHT",
    });
    assert.ok(!("start_line" in p.comments[0]));
    assert.ok(!("subjectType" in p.comments[0])); // subjectType は落とす
  });

  test("toComment: 複数行は start_line/start_side を snake_case に変換する", () => {
    const p = buildPayload({ summaryBody: "s", comments: [multi] }, { commitId: "x" });
    assert.deepEqual(p.comments[0], {
      path: "src/b.js",
      body: "範囲コメント",
      line: 4,
      side: "RIGHT",
      start_line: 3,
      start_side: "RIGHT",
    });
  });

  test("buildPayload: suggestion ブロックを含む body をそのまま保持する", () => {
    const body =
      "コメント削除を提案\n```suggestion\nexport function target() {}\n```";
    const p = buildPayload(
      { summaryBody: "s", comments: [{ ...multi, body }] },
      { commitId: "deadbeef" }
    );
    assert.equal(p.comments[0].body, body);
    assert.equal(p.comments[0].start_line, 3);
    assert.equal(p.comments[0].line, 4);
  });

  test("フィルタ: resolved:false の要素はインライン化されず自動スキップされる", () => {
    const p = buildPayload(
      {
        summaryBody: "s",
        comments: [
          single,
          { path: "src/c.js", resolved: false, reason: "diff 不一致" },
        ],
      },
      { commitId: "x" }
    );
    assert.equal(p.comments.length, 1);
    assert.equal(p.comments[0].path, "src/a.js");
  });

  test("検証: comments が配列でなければ throw する", () => {
    assert.throws(
      () => buildPayload({ summaryBody: "s" }, { commitId: "x" }),
      /comments は配列/
    );
  });

  test("検証: resolved:true なのに params.line が無ければ throw する", () => {
    // サイレント失敗防止の要: params を欠く resolved:true 要素は投稿前に必ず弾かれ、
    // コメントが黙って消えることはない。
    assert.throws(
      () =>
        buildPayload(
          { summaryBody: "s", comments: [{ path: "src/a.js", resolved: true, body: "x" }] },
          { commitId: "x" }
        ),
      /params\.line がありません/
    );
  });

  test("検証: resolved:true なのに body が空なら throw する", () => {
    assert.throws(
      () =>
        buildPayload(
          {
            summaryBody: "s",
            comments: [{ path: "src/a.js", resolved: true, body: "  ", params: { line: 1, side: "RIGHT" } }],
          },
          { commitId: "x" }
        ),
      /body が空/
    );
  });

  test("許容: 全要素 resolved:false ならサマリのみ投稿を許容し throw しない", () => {
    const p = buildPayload(
      {
        summaryBody: "問題は見つかりませんでした。",
        comments: [
          { path: "src/a.js", resolved: false, reason: "diff 不一致" },
          { path: "src/b.js", resolved: false, reason: "複数一致" },
        ],
      },
      { commitId: "x" }
    );
    assert.deepEqual(p.comments, []);
    assert.equal(p.body, "問題は見つかりませんでした。");
  });
}
