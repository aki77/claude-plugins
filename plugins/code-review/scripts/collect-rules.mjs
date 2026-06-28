#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();

// ---- 引数パース --------------------------------------------------------------
// --pr <PR>      : GitHub PR の変更ファイルを対象にする
// --range [<r>]  : ローカル git range の変更ファイルを対象にする（省略時は自動解決）
function parseArgs(argv) {
  const args = argv.slice(2);
  const mode = args[0];
  if (mode === "--pr") {
    const pr = args[1];
    if (!pr) usage();
    return { mode: "pr", pr };
  }
  if (mode === "--range") {
    return { mode: "range", range: args[1] };
  }
  usage();
}

function usage() {
  console.error(
    "Usage:\n" +
      "  collect-rules.mjs --pr <PR>\n" +
      "  collect-rules.mjs --range [<range>]\n" +
      "例: collect-rules.mjs --pr 123\n" +
      "    collect-rules.mjs --range main"
  );
  process.exit(1);
}

// ---- 変更ファイル取得 --------------------------------------------------------
function getChangedFilesFromPr(pr) {
  const out = execFileSync("gh", ["pr", "diff", pr, "--name-only"], {
    encoding: "utf8",
  });
  return splitLines(out);
}

function getChangedFilesFromRange(range) {
  const out = execFileSync("git", ["diff", "--name-only", range], {
    encoding: "utf8",
  });
  return splitLines(out);
}

function getStagedFiles() {
  const out = execFileSync("git", ["diff", "--staged", "--name-only"], {
    encoding: "utf8",
  });
  return splitLines(out);
}

function splitLines(out) {
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveRange(arg) {
  if (arg) {
    // `..` / `...` を含まない場合は base のみとみなして `<arg>...HEAD` に補完
    if (!arg.includes("..")) {
      return `${arg}...HEAD`;
    }
    return arg;
  }

  // 自動解決
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).trim();

  // 1. github-pr-base-branch
  try {
    const raw = execFileSync(
      "git",
      ["config", `branch.${branch}.github-pr-base-branch`],
      { encoding: "utf8" }
    ).trim();
    // `owner/repo#123` 形式から `#番号` を除去してブランチ名を得る
    const baseBranch = raw.replace(/#\S*$/, "").trim();
    if (baseBranch) {
      const base = execFileSync("git", ["merge-base", baseBranch, "HEAD"], {
        encoding: "utf8",
      }).trim();
      return `${base}...HEAD`;
    }
  } catch {}

  // 2. vscode-merge-base
  try {
    const base = execFileSync(
      "git",
      ["config", `branch.${branch}.vscode-merge-base`],
      { encoding: "utf8" }
    ).trim();
    if (base) return `${base}...HEAD`;
  } catch {}

  // 3. @{upstream}
  try {
    const base = execFileSync("git", ["merge-base", "@{upstream}", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (base) return `${base}...HEAD`;
  } catch {}

  // 4. origin/HEAD
  try {
    const base = execFileSync("git", ["merge-base", "origin/HEAD", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (base) return `${base}...HEAD`;
  } catch {}

  console.error(
    "Error: ベースブランチを自動解決できませんでした。\n" +
      "引数として範囲を明示してください。例: collect-rules.mjs --range main"
  );
  process.exit(1);
}

// ---- CLAUDE.md 収集 ----------------------------------------------------------
// 単一ファイルに適用される CLAUDE.md 群を、親ディレクトリを遡って収集する。
// 同一ディレクトリ配下の複数ファイルで同じ遡上 stat を繰り返さないよう、結果を
// ディレクトリ単位でメモ化する（多数の変更ファイルで existsSync 反復を削減）。
const claudeMdCache = new Map();

function claudeMdForFile(file) {
  const startDir = path.dirname(file);
  if (claudeMdCache.has(startDir)) return claudeMdCache.get(startDir);
  const results = [];
  if (existsSync(path.join(cwd, "CLAUDE.md"))) {
    results.push("CLAUDE.md");
  }
  let dir = startDir;
  while (dir && dir !== "." && dir !== "/") {
    const candidate = path.join(dir, "CLAUDE.md");
    if (existsSync(path.join(cwd, candidate))) {
      results.push(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const sorted = [...new Set(results)].sort();
  claudeMdCache.set(startDir, sorted);
  return sorted;
}

// ---- .claude/rules/ パース ---------------------------------------------------
function parseFrontmatterPaths(content) {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = content.slice(3, end);
  const lines = fm.split("\n");

  let inPaths = false;
  let pathsIndent = -1;
  const collected = [];
  let foundPathsKey = false;

  for (const line of lines) {
    if (!inPaths) {
      const m = line.match(/^(\s*)paths\s*:\s*(.*)$/);
      if (m) {
        foundPathsKey = true;
        const rest = m[2].trim();
        if (rest.startsWith("[")) {
          const inline = rest.replace(/^\[|\]$/g, "");
          for (const item of inline.split(",")) {
            const v = item.trim().replace(/^["']|["']$/g, "");
            if (v) collected.push(v);
          }
          return collected;
        }
        inPaths = true;
        pathsIndent = m[1].length;
      }
    } else {
      if (line.trim() === "") continue;
      const indent = line.match(/^\s*/)[0].length;
      const itemMatch = line.match(/^\s*-\s+(.+)$/);
      if (itemMatch && indent > pathsIndent) {
        const v = itemMatch[1].trim().replace(/^["']|["']$/g, "");
        collected.push(v);
      } else {
        break;
      }
    }
  }

  return foundPathsKey ? collected : null;
}

async function listRuleFiles() {
  const rulesDir = path.join(cwd, ".claude/rules");
  if (!existsSync(rulesDir)) return [];
  const matches = [];
  for await (const entry of glob("**/*.md", { cwd: rulesDir })) {
    matches.push(path.join(".claude/rules", entry));
  }
  return matches.sort();
}

// 単一ファイルのパスが patterns のいずれかにマッチするか。
// path.matchesGlob はパス文字列同士のマッチ（ファイルシステムを走査しない）なので、
// 削除ファイルや浅いクローンなど作業ツリーに実在しないパスでも正しく判定できる。
// 姉妹スクリプト（plan-rule-review の collect-plan-rules.mjs）と同じ方式。
function fileMatchesPatterns(file, patterns) {
  return patterns.some((pattern) => path.matchesGlob(file, pattern));
}

// PR/range 全体で「適用されうる」ルール一覧を収集する。
// paths が null（全ファイル適用）か、変更ファイルのいずれかが paths にマッチするものを残す。
async function collectRules(changedFiles) {
  const files = await listRuleFiles();
  const results = [];
  for (const file of files) {
    const content = readFileSync(path.join(cwd, file), "utf8");
    const paths = parseFrontmatterPaths(content);
    if (paths === null) {
      results.push({ path: file, paths: null });
    } else if (paths.length === 0) {
      continue;
    } else if (changedFiles.some((f) => fileMatchesPatterns(f, paths))) {
      results.push({ path: file, paths });
    }
  }
  return results;
}

// ---- ファイル単位の適用ルール算出 ------------------------------------------
// 各変更ファイルについて、適用されるルールファイルのパス一覧を求める。
// CLAUDE.md と .claude/rules/ を区別せず、エージェントが参照すべきファイルとして
// 1つの配列に統合する（CLAUDE.md → .claude/rules/ の順で並べる）。
function rulesForFile(file, allRules) {
  const rules = [...claudeMdForFile(file)];
  for (const rule of allRules) {
    if (rule.paths === null) {
      rules.push(rule.path);
    } else if (fileMatchesPatterns(file, rule.paths)) {
      rules.push(rule.path);
    }
  }
  return rules;
}

// ---- ルールセット単位グルーピング + 2バケットパック ------------------------
// 適用ルールセット（適用ルールファイルのパス集合）が同一のファイルを1グループに集約し、
// 2エージェント分のバケットへ振り分ける。配置の方針:
//   1. 各バケットの「ルール和集合」を骨格グループ（他グループのルールセットの部分集合に
//      ならない極大グループ）で確定する。
//   2. 自分のルールセットがバケットのルール和集合の部分集合になっているグループ（=どちらに
//      入れても余分なルールを読まない）は、ファイル数が少ないバケットへ自由に振り分けて
//      均等化する。これにより「コンテキスト重複ゼロ」を保ったままファイル数を平準化できる。
function buildAssignments(changedFiles, allRules, resolveRules = rulesForFile) {
  // ファイル → 適用ルールセット（グループ化）
  const groupsByKey = new Map();
  for (const file of changedFiles) {
    const rules = resolveRules(file, allRules);
    const key = JSON.stringify([...rules].sort());
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, { ruleSet: new Set(rules), files: [] });
    }
    groupsByKey.get(key).files.push({ path: file, rules });
  }

  const groups = [...groupsByKey.values()];
  const buckets = [
    { files: [], ruleUnion: new Set() },
    { files: [], ruleUnion: new Set() },
  ];

  const isSubset = (sub, sup) => {
    for (const r of sub) if (!sup.has(r)) return false;
    return true;
  };
  const smaller = () =>
    buckets[0].files.length <= buckets[1].files.length ? buckets[0] : buckets[1];
  const place = (bucket, group, files) => {
    for (const f of files) bucket.files.push(f);
    for (const r of group.ruleSet) bucket.ruleUnion.add(r);
  };

  if (groups.length === 1) {
    // 縮退ケース: グループが1つだけなら、その単一グループを2バケットへ均等割りする
    // （同一ルールセットなのでコンテキスト重複は発生しない）。
    const only = groups[0];
    const half = Math.ceil(only.files.length / 2);
    place(buckets[0], only, only.files.slice(0, half));
    place(buckets[1], only, only.files.slice(half));
  } else {
    // 「骨格グループ」= ルールセットが他グループのルールセットの真部分集合になっていない
    // 極大グループ。これらが各バケットのルール和集合を決める。残りは filler。
    const isMaximal = (g) =>
      !groups.some(
        (o) => o !== g && o.ruleSet.size > g.ruleSet.size && isSubset(g.ruleSet, o.ruleSet)
      );
    const skeleton = [];
    const fillers = [];
    for (const g of groups) (isMaximal(g) ? skeleton : fillers).push(g);

    // 骨格はファイル数降順に LPT 配置（分割しない）。各バケットのルール和集合が確定する。
    for (const g of skeleton.sort((a, b) => b.files.length - a.files.length)) {
      place(smaller(), g, g.files);
    }

    // filler グループのファイルは1ファイル単位で、ルール和集合の部分集合になっている
    // バケットのうち少ない方へ入れて均等化する（余分なルールは読ませない）。
    const flatFillers = fillers.flatMap((g) =>
      g.files.map((f) => ({ file: f, ruleSet: g.ruleSet }))
    );
    for (const { file, ruleSet } of flatFillers) {
      // 余分なルールを読ませないバケットを優先候補にする。次のいずれかを満たすバケット:
      //   - ruleSet がバケット和集合の部分集合（入れても和集合が増えない）
      //   - バケット和集合が ruleSet の部分集合（入れてもそのバケットは ruleSet 内の
      //     ルールしか読まない。空バケットも常にこれを満たす）
      const candidates = buckets.filter(
        (b) => isSubset(ruleSet, b.ruleUnion) || isSubset(b.ruleUnion, ruleSet)
      );
      const pool = candidates.length ? candidates : buckets;
      const target = pool.reduce((a, b) => (a.files.length <= b.files.length ? a : b));
      place(target, { ruleSet }, [file]);
    }
  }

  return buckets.map((b) => ({
    files: b.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  }));
}

// ---- main --------------------------------------------------------------------
// `node --test` で読み込んだときは NODE_TEST_CONTEXT がセットされる。そのときは main を
// スキップして末尾のインラインテストだけ動かす。通常の CLI 実行ではここが走る。
// （import.meta.main は Node 24+ 限定のため使わず、バージョン非依存にする。）
if (!process.env.NODE_TEST_CONTEXT) {
  const opts = parseArgs(process.argv);

  let range;
  let changedFiles;
  if (opts.mode === "pr") {
    changedFiles = getChangedFilesFromPr(opts.pr);
  } else {
    // 引数なし実行 かつ ステージ済み変更あり → staged モード（コミット前レビュー）。
    // それ以外は range を解決する。range の有無で staged / range を判別する。
    const staged = opts.range ? [] : getStagedFiles();
    if (staged.length > 0) {
      changedFiles = staged;
    } else {
      range = resolveRange(opts.range);
      changedFiles = getChangedFilesFromRange(range);
    }
  }

  const rules = await collectRules(changedFiles);
  const assignments = buildAssignments(changedFiles, rules);

  const output = { assignments };
  if (opts.mode === "range") {
    // range があれば range モード、なければ staged モード。diffArgs は後続の
    // `git diff <diffArgs>` 用引数（SKILL 側の差分取得を一様化する）。
    output.source = range ? "range" : "staged";
    output.diffArgs = range ? [range] : ["--staged"];
    if (range) output.range = range;
    output.changedFiles = changedFiles;
  }

  console.log(JSON.stringify(output, null, 2));
}

// ---- インラインテスト --------------------------------------------------------
// `node --test plugins/code-review/scripts/collect-rules.mjs` で実行する。
// 参照: https://github.com/nodejs/node/issues/48956
// FS に依存しない純粋ロジック（glob 照合・frontmatter パース・バケット配置）を検証する。
// buildAssignments は resolveRules を注入して FS 非依存にテストする。
if (process.env.NODE_TEST_CONTEXT) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  // 各バケットが「自身の担当ファイルに適用されるルール」だけを読むこと（=余分なルールを
  // 読まないこと）を検証するヘルパ。バケットのルール和集合が、骨格となるべきルールセットを
  // 超えて膨らんでいないかを、ファイル単位ルールとの整合で確認する。
  const bucketRuleUnion = (bucket) =>
    new Set(bucket.files.flatMap((f) => f.rules));
  const fileCounts = (assignments) => assignments.map((a) => a.files.length);

  // テスト用の resolveRules: ファイルパスのプレフィックスからルールセットを返す疑似実装。
  const fakeResolve = (file) => {
    const rules = ["CLAUDE.md", "comment"];
    if (file.startsWith("models/")) rules.push("app-models");
    if (file.startsWith("migrate/")) rules.push("db-migrate");
    if (file.startsWith("views/")) rules.push("app-views");
    return rules;
  };
  const build = (files) =>
    buildAssignments(files, [], fakeResolve);

  const matches = (file, pattern) => fileMatchesPatterns(file, [pattern]);

  test("fileMatchesPatterns: ** はディレクトリを跨いでマッチする", () => {
    assert.ok(matches("app/views/x.erb", "app/views/**/*"));
    assert.ok(matches("app/views/active_storage/blobs/_blob.html.erb", "app/views/**/*"));
    assert.ok(!matches("app/models/x.rb", "app/views/**/*"));
  });

  test("fileMatchesPatterns: * は / を跨がない", () => {
    assert.ok(matches("app/models/user.rb", "app/models/*.rb"));
    assert.ok(!matches("app/models/admin/user.rb", "app/models/*.rb"));
  });

  test("fileMatchesPatterns: 単一ファイルパスは完全一致のみ", () => {
    assert.ok(matches("config/routes.rb", "config/routes.rb"));
    assert.ok(!matches("config/routes/admin.rb", "config/routes.rb"));
  });

  test("fileMatchesPatterns: {a,b} と ? を扱える", () => {
    assert.ok(matches("db/migrate/x.rb", "db/{migrate,seeds}/x.rb"));
    assert.ok(matches("db/seeds/x.rb", "db/{migrate,seeds}/x.rb"));
    assert.ok(matches("ab.rb", "a?.rb"));
    assert.ok(!matches("a/.rb", "a?.rb"));
  });

  test("fileMatchesPatterns: 削除ファイル等 FS に無いパスでも文字列で照合できる", () => {
    // 作業ツリーを一切参照しないことの確認（純粋な文字列マッチ）
    assert.ok(matches("app/views/deleted/gone.erb", "app/views/**/*"));
  });

  test("fileMatchesPatterns: いずれかにマッチすれば true", () => {
    const patterns = ["app/components/**/*", "app/views/**/*"];
    assert.ok(fileMatchesPatterns("app/components/x.rb", patterns));
    assert.ok(fileMatchesPatterns("app/views/x.erb", patterns));
    assert.ok(!fileMatchesPatterns("app/models/x.rb", patterns));
  });

  test("parseFrontmatterPaths: paths 未指定は null（全ファイル適用）", () => {
    assert.equal(parseFrontmatterPaths("no frontmatter"), null);
    assert.equal(parseFrontmatterPaths("---\nfoo: bar\n---\nbody"), null);
  });

  test("parseFrontmatterPaths: ブロック形式の paths を配列で返す", () => {
    const fm = "---\npaths:\n  - 'app/models/**/*.rb'\n  - \"config/routes.rb\"\n---\nbody";
    assert.deepEqual(parseFrontmatterPaths(fm), ["app/models/**/*.rb", "config/routes.rb"]);
  });

  test("parseFrontmatterPaths: インライン配列形式の paths を扱える", () => {
    const fm = "---\npaths: ['app/views/**/*']\n---\nbody";
    assert.deepEqual(parseFrontmatterPaths(fm), ["app/views/**/*"]);
  });

  test("buildAssignments: ルールなし → 両バケット空", () => {
    const a = build([]);
    assert.deepEqual(fileCounts(a), [0, 0]);
  });

  test("buildAssignments: 単一グループは2バケットへ均等割り", () => {
    const a = build(["a.txt", "b.txt", "c.txt", "d.txt"]);
    assert.deepEqual(fileCounts(a), [2, 2]);
  });

  test("buildAssignments: 巨大な共通グループ + 小グループ2つを均等化（#780型）", () => {
    // comment-only 30 + models 3 + migrate 3 = 36 → 18 対 18
    const files = [];
    for (let i = 0; i < 30; i++) files.push(`docs/d${i}.md`);
    for (let i = 0; i < 3; i++) files.push(`models/m${i}.rb`);
    for (let i = 0; i < 3; i++) files.push(`migrate/g${i}.rb`);
    const a = build(files);
    assert.deepEqual(fileCounts(a), [18, 18]);
    // 各バケットは app-models か db-migrate の一方だけを読み、両方は読まない
    const u0 = bucketRuleUnion(a[0]);
    const u1 = bucketRuleUnion(a[1]);
    assert.ok(!(u0.has("app-models") && u0.has("db-migrate")));
    assert.ok(!(u1.has("app-models") && u1.has("db-migrate")));
  });

  test("buildAssignments: 大グループ + 部分集合 filler を均等化（#792型）", () => {
    // views 17（app-views+comment） + config 6（comment のみ=views の部分集合）
    const files = [];
    for (let i = 0; i < 17; i++) files.push(`views/v${i}.erb`);
    for (let i = 0; i < 6; i++) files.push(`config/c${i}.yml`);
    const a = build(files);
    // 骨格 views(17) は分割されず片方に、filler config(6) はもう片方に寄って 17 対 6
    const counts = fileCounts(a).sort((x, y) => y - x);
    assert.deepEqual(counts, [17, 6]);
    // config 側バケットは app-views を読まない（余分なルールゼロ）
    const configBucket = a.find((b) => b.files.some((f) => f.path.startsWith("config/")));
    assert.ok(!bucketRuleUnion(configBucket).has("app-views"));
  });

  test("buildAssignments: 各ファイルに適用ルールが付与される", () => {
    const a = build(["models/user.rb"]);
    const file = a.flatMap((b) => b.files).find((f) => f.path === "models/user.rb");
    assert.deepEqual(file.rules.sort(), ["CLAUDE.md", "app-models", "comment"].sort());
  });
}
