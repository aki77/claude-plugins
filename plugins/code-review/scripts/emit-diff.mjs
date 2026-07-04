#!/usr/bin/env node
// レビューパイプラインで使う統一 diff を、単一の許可コマンドで stdout に出すラッパ。
//
// なぜ必要か: headless（claude-code-action 等の非対話）実行では、Claude Code の Bash
// permission 静的解析が `$(...)` コマンド置換・パイプ・複合コマンドを許可できず即拒否する。
// 従来 SKILL / review-core が使っていた
//   git diff $(jq -r '.diffArgs[]' "$CTX") $(jq -r '.excludeArgs.git[]' "$CTX")
// は二重の `$()` を含むため headless では通らない。このスクリプトは CTX（および任意で
// CLUSTERS）を `--flag value`（＝`$VAR` 展開のみで組める許可される形）で受け取り、diff を
// stdout に直出しする。エージェントはこの出力をそのまま読む（一時ファイルへ保存しない）。
//
// 使い方:
//   node emit-diff.mjs --context <CTX>
//     → レビュー対象外ファイルを除外した「全体 diff」を stdout に出す
//       （エージェント3・5・サマリエージェント・4b の diff 確認用）。
//   node emit-diff.mjs --context <CTX> --clusters <CLUSTERS> --cluster-id <N>
//     → CLUSTERS（validate-clusters.mjs 出力）の clusters[].id == N の changedFiles
//       だけに絞った diff を stdout に出す（エージェント4=クラスタ担当用）。
//       changedFiles は CTX の変更ファイルと積集合済みなので、担当外・除外ファイルは出ない。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { fail, parseFlags, readArtifact } from "./lib/artifact.mjs";
import { buildDiffArgs } from "./lib/diff-anchor.mjs";

// CTX からベースの git diff 引数（`-c core.quotepath=false diff <diffArgs> <excludeArgs>`）を
// 組み、cluster-id 指定時はその末尾の pathspec を「担当 changedFiles のみ」に差し替える。
//   - 全体 diff: buildDiffArgs(ctx) をそのまま使う（excludeArgs = `-- . :(exclude)...` または []）。
//   - 担当 diff: `-- <担当path...>` を pathspec とする。changedFiles は除外済みのため
//     :(exclude) は不要（担当外は列挙されないので原理的に出ない）。
export function buildEmitArgs(ctx, clusterFiles) {
  if (clusterFiles == null) return buildDiffArgs(ctx);
  const diffArgs = ctx.diffArgs ?? [];
  return ["-c", "core.quotepath=false", "diff", ...diffArgs, "--", ...clusterFiles];
}

// CLUSTERS から id が clusterId のクラスタの changedFiles を取り出す。
// 見つからなければ actionable なメッセージで fail する。
function clusterFilesById(clusters, clusterId) {
  const list = clusters?.clusters ?? [];
  const found = list.find((c) => String(c.id) === String(clusterId));
  if (!found) {
    fail(
      `--cluster-id ${clusterId} に一致するクラスタが CLUSTERS に見つかりません（存在する id: ${list.map((c) => c.id).join(", ") || "なし"}）。`,
    );
  }
  const files = found.changedFiles ?? [];
  if (files.length === 0) {
    fail(`クラスタ id ${clusterId} の changedFiles が空です。`);
  }
  return files;
}

function main() {
  const opts = parseFlags(process.argv, {
    flags: ["--context", "--clusters", "--cluster-id"],
    required: ["--context"],
    usage:
      "node emit-diff.mjs --context <CTX> [--clusters <CLUSTERS> --cluster-id <N>]",
  });

  const ctx = readArtifact(opts.context);

  // parseFlags は `--cluster-id` を `cluster-id` キーにする（camel 変換はしない）。
  const clusterId = opts["cluster-id"];
  let clusterFiles = null;
  if (clusterId != null || opts.clusters != null) {
    if (clusterId == null || opts.clusters == null) {
      fail("--clusters と --cluster-id は同時に指定してください（片方だけは不可）。");
    }
    const clusters = readArtifact(opts.clusters);
    clusterFiles = clusterFilesById(clusters, clusterId);
  }

  const args = buildEmitArgs(ctx, clusterFiles);
  let diff;
  try {
    diff = execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    fail(`git diff の実行に失敗しました: ${e.message}`);
  }
  process.stdout.write(diff);
}

// ---- インラインテスト --------------------------------------------------------
// `node --test plugins/code-review/scripts/emit-diff.mjs` で実行する。
// git を叩かない純粋ロジック（buildEmitArgs / clusterFilesById）だけを検証する。
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  test("buildEmitArgs: 全体 diff は buildDiffArgs と同一（除外あり）", () => {
    const ctx = {
      diffArgs: ["abc123...HEAD"],
      excludeArgs: { git: ["--", ".", ":(exclude)dist/bundle.js"] },
    };
    assert.deepEqual(buildEmitArgs(ctx, null), [
      "-c",
      "core.quotepath=false",
      "diff",
      "abc123...HEAD",
      "--",
      ".",
      ":(exclude)dist/bundle.js",
    ]);
  });

  test("buildEmitArgs: 全体 diff（除外なし）", () => {
    const ctx = { diffArgs: ["--staged"], excludeArgs: { git: [] } };
    assert.deepEqual(buildEmitArgs(ctx, null), [
      "-c",
      "core.quotepath=false",
      "diff",
      "--staged",
    ]);
  });

  test("buildEmitArgs: クラスタ担当 diff は担当 changedFiles を pathspec にする", () => {
    const ctx = {
      diffArgs: ["abc123...HEAD"],
      excludeArgs: { git: ["--", ".", ":(exclude)dist/bundle.js"] },
    };
    assert.deepEqual(buildEmitArgs(ctx, ["app/a.rb", "app/b.rb"]), [
      "-c",
      "core.quotepath=false",
      "diff",
      "abc123...HEAD",
      "--",
      "app/a.rb",
      "app/b.rb",
    ]);
  });

  test("clusterFilesById: id 一致（数値/文字列どちらでも）", () => {
    const clusters = {
      clusters: [
        { id: 1, changedFiles: ["a.rb"] },
        { id: 2, changedFiles: ["b.rb", "c.rb"] },
      ],
    };
    assert.deepEqual(clusterFilesById(clusters, 2), ["b.rb", "c.rb"]);
    assert.deepEqual(clusterFilesById(clusters, "1"), ["a.rb"]);
  });
}

// テスト実行時（NODE_TEST_CONTEXT）は main を呼ばない。
if (!process.env.NODE_TEST_CONTEXT) {
  main();
}
