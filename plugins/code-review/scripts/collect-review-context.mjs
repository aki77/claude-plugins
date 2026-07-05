#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cwd = process.cwd();

// ---- レビュー対象外のデフォルト除外パターン ---------------------------------
// レビューして意味のないファイル（生成物・ミニファイ・バイナリ）を機械的に除外する。
// ロックファイル・スナップショットは含めない（有用な変更を誤って隠すリスクを避ける）。
// プロジェクト側で追加除外したい場合は .gitattributes に linguist 属性
// （linguist-generated / linguist-vendored / linguist-documentation）を付与する。
// 値なし記法（`path linguist-generated`）でも `=true` でも効く（detectLinguistExcluded が拾う）。
// glob は path.matchesGlob（`fileMatchesPatterns`）で照合する純粋な文字列マッチ。
const DEFAULT_EXCLUDE_GLOBS = [
  // ミニファイ / source map / 典型的なビルド生成物ディレクトリ
  // `**/dist/**` は `**` が0セグメントにマッチするためトップレベルの `dist/x` も拾う
  // （`dist/**` は不要）。
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  // 画像バイナリ（SVG はテキスト diff として有用なので含めない）
  "**/*.{png,jpg,jpeg,gif,webp,ico,bmp,avif,heic}",
  // フォント
  "**/*.{woff,woff2,ttf,eot,otf}",
  // 圧縮・アーカイブ・ドキュメントバイナリ
  "**/*.{pdf,zip,gz,tgz,bz2,xz,7z,rar,jar}",
  // 動画・音声
  "**/*.{mp4,mov,webm,avi,mkv,mp3,wav,flac,ogg}",
];

// ---- 変更規模 tier のしきい値 ------------------------------------------------
// 小さい差分では固定コスト（サマリ+クラスタ分割エージェント・ルール準拠2体目・
// クラスタ整合性2体目以降・バグ検出）を削るため、変更規模を tier で分類する。
// 判定はここ（決定論・コード側）で確定させ、CTX の tier としてプロンプトへ渡す
// （プロンプトは規模判定ロジックを一切持たず tier の値を読むだけ）。
// totalFiles / totalChangedLines はいずれも「レビュー対象（kept）ファイル」基準。
// 環境変数で上書き可能（利用リポジトリごとにプロンプト改変なしで調整できる）。
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const TIER_THRESHOLDS = {
  tiny: {
    maxFiles: num(process.env.CODE_REVIEW_TINY_MAX_FILES, 2),
    maxLines: num(process.env.CODE_REVIEW_TINY_MAX_LINES, 50),
  },
  small: {
    maxFiles: num(process.env.CODE_REVIEW_SMALL_MAX_FILES, 5),
    maxLines: num(process.env.CODE_REVIEW_SMALL_MAX_LINES, 150),
  },
};

// 1ファイルの変更行数（追加+削除）がこれを「超えたら」レビュー対象から外し oversizedFiles に
// 分離する（generated/バイナリの excludedFiles とは別枠。こちらは「大規模ゆえに個別レビューが
// 困難」）。本プラグインはトークン実測機構を持たないため行数で近似する。デフォルト 1000 は
// 複数ファイルを1エージェントに渡す本構成で単一ファイルがコンテキストを占有しすぎない中庸値。
// 環境変数で調整可能。tier の行数しきい値（TIER_THRESHOLDS.small.maxLines 等）より大きい前提で、
// これを下げて tier しきい値を下回らせると「単一ファイルが tier しきい値を跨ぐ前に oversized 落ち」
// して tier の意味が変わるので注意（両しきい値とも「変更規模の分類」という同じ概念系に属する）。
const OVERSIZED_MAX_LINES = num(process.env.CODE_REVIEW_OVERSIZED_MAX_LINES, 1000);

// 変更規模から tier（"tiny" | "small" | "normal"）を決める純粋関数。
// tiny/small はいずれも「ファイル数 AND 行数」の両方がしきい値未満のときのみ該当し、
// どちらか一方でも超えたら上位 tier（最終的に normal）へ繰り上がる。
function classifyTier(totalFiles, totalChangedLines) {
  const { tiny, small } = TIER_THRESHOLDS;
  if (totalFiles <= tiny.maxFiles && totalChangedLines < tiny.maxLines) {
    return "tiny";
  }
  if (totalFiles <= small.maxFiles && totalChangedLines < small.maxLines) {
    return "small";
  }
  return "normal";
}

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
      "  collect-review-context.mjs --pr <PR>\n" +
      "  collect-review-context.mjs --range [<range>]\n" +
      "例: collect-review-context.mjs --pr 123\n" +
      "    collect-review-context.mjs --range main"
  );
  process.exit(1);
}

// ---- 変更ファイル取得 --------------------------------------------------------
// PR の base 先端（baseRefOid）を解決し、ローカル three-dot range `<baseRefOid>...HEAD`
// を返す。diff 取得を PR/local 両モードで完全に同型（ローカル git diff）にするための要。
// ステップ0で「ローカル HEAD == PR headRefOid」が保証されているため、この three-dot
// range の merge base は GitHub の PR base と一致する。base コミットがローカルに無い
// （fork PR / shallow clone）場合は actionable なメッセージで throw する。
// exec は依存注入（既存テストスタイルに合わせ、FS/プロセス非依存でテストするため）。
function resolvePrBaseRange(pr, { exec = execFileSync } = {}) {
  const raw = exec("gh", ["pr", "view", pr, "--json", "baseRefOid,baseRefName"], {
    encoding: "utf8",
  });
  const meta = JSON.parse(raw);
  const baseRefOid = meta.baseRefOid;
  const baseRefName = meta.baseRefName;
  if (!baseRefOid) {
    throw new Error(
      `PR #${pr} の baseRefOid を取得できませんでした（gh pr view の出力に baseRefOid がありません）。`
    );
  }

  // base コミットがローカルに存在するか。fork PR / shallow clone では欠落しうる。
  try {
    exec("git", ["cat-file", "-e", `${baseRefOid}^{commit}`], {
      encoding: "utf8",
    });
  } catch {
    throw new Error(
      `PR #${pr} の base コミット（${baseRefOid}）がローカルに存在しません。` +
        `\`git fetch origin ${baseRefName}\` を実行して再実行してください` +
        `（fork PR の場合は base リポジトリの remote を指定）。`
    );
  }

  // three-dot の merge base を計算できるか。shallow clone では失敗しうる。
  try {
    exec("git", ["merge-base", baseRefOid, "HEAD"], { encoding: "utf8" });
  } catch {
    throw new Error(
      `PR #${pr} の base（${baseRefOid}）と HEAD の merge base を計算できませんでした。` +
        `\`git fetch --unshallow\` または \`git fetch origin ${baseRefName}\` を実行して再実行してください。`
    );
  }

  return `${baseRefOid}...HEAD`;
}

function getChangedFilesFromRange(range) {
  // GitHub は常時 rename 検出のため --find-renames を明示する
  // （diff.renames=false なリポジトリでの列挙差異を防ぐ）。
  const out = execFileSync("git", ["diff", "--name-only", "--find-renames", range], {
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

// `git diff --numstat` の生出力を [{ added, deleted, path }] にパースする純粋関数。
// numstat の各行は `added<TAB>deleted<TAB>path`。バイナリファイルは added/deleted が
// `-` になるため数値化できず、行数集計から除外する（null で表現）。
// rename は `old => new` 形式や `{a => b}` 形式になるが、path 自体は tier 判定では
// kept セットとの照合に使わない（集計は行数のみ）ため、パスの厳密復元は不要。
function parseNumstat(out) {
  const rows = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? null : Number(parts[0]);
    const deleted = parts[1] === "-" ? null : Number(parts[1]);
    rows.push({ added, deleted, path: parts.slice(2).join("\t") });
  }
  return rows;
}

// レビュー対象（kept）ファイルの変更「行数」を算出する。
// diffArgs（range or --staged）と excludeArgs.git（生成物・バイナリの除外 pathspec）を
// 本 diff とまったく同じ引数で numstat に渡すことで、tier 判定が本 diff とズレないようにする。
// バイナリ行（added/deleted が null）は行数集計に含めない。
// perFile は「numstat の生パス → { added, deleted }」の Map。oversized 検出と、oversized を
// 除いた metrics の再計算（git を再実行せず減算で求める）に使う。
// numstat の path は rename 時に `old => new` 等の形式になりうるが、正規化はしない
// （呼び出し側で kept セットと素朴照合し、照合できないものは oversized 判定から漏れて
// レビュー対象に残る＝安全側。複雑な rename 正規化を持ち込んでバグ源にしない）。
function collectChangedLines(diffArgs, excludeArgs) {
  const args = ["diff", "--numstat", "--find-renames", ...diffArgs, ...excludeArgs];
  let out;
  try {
    out = execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    // numstat の取得に失敗しても tier 判定を落とさない（normal 相当＝全エージェント起動）。
    return { totalAdded: 0, totalDeleted: 0, totalChangedLines: 0, perFile: new Map() };
  }
  let totalAdded = 0;
  let totalDeleted = 0;
  const perFile = new Map();
  for (const r of parseNumstat(out)) {
    if (r.added != null) totalAdded += r.added;
    if (r.deleted != null) totalDeleted += r.deleted;
    if (r.added != null && r.deleted != null) {
      perFile.set(r.path, { added: r.added, deleted: r.deleted });
    }
  }
  return { totalAdded, totalDeleted, totalChangedLines: totalAdded + totalDeleted, perFile };
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
      "引数として範囲を明示してください。例: collect-review-context.mjs --range main"
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

// ---- レビュー対象ファイルのフィルタリング ------------------------------------
// .gitattributes の linguist 除外属性が付いた変更ファイルの集合を返す。
// 対象属性は GitHub linguist が言語統計から外すのと同じ3つ:
//   linguist-generated / linguist-vendored / linguist-documentation
// git check-attr を --stdin -z で一括問い合わせし、プロセス呼び出しを1回に抑える。
// 変更ファイルが空なら git を呼ばず空の Set を返す。
const LINGUIST_EXCLUDE_ATTRS = [
  "linguist-generated",
  "linguist-vendored",
  "linguist-documentation",
];

function detectLinguistExcluded(files) {
  if (files.length === 0) return new Set();
  const input = files.map((f) => f + "\0").join("");
  const out = execFileSync(
    "git",
    ["check-attr", "--stdin", "-z", ...LINGUIST_EXCLUDE_ATTRS],
    { input, encoding: "utf8" }
  );
  return parseCheckAttrOutput(out);
}

// git check-attr --stdin -z の出力をパースして、除外対象パスの Set を返す純粋関数。
// 出力は NUL 区切りで <path>\0<attr>\0<value>\0 の3つ組が繰り返される。問い合わせた
// 属性ごとに1つ組が出るため、同一パスが複数回現れる。value の意味:
//   set … 値なし記法（`path linguist-generated`）／true・任意の値 … `=true`/`=1` 等で付与
//   unspecified … 属性なし ／ unset … `-attr` で打ち消し ／ false … `=false`
// GitHub linguist は「明示的な打ち消し以外の設定値」を override 有効として扱うため、
// 除外は「無効値（unspecified/unset/false）でない」を判定する。こうすることで
// `=1`・`=yes` のような set/true 以外の設定値でも取りこぼさない。
const ATTR_NEGATIVE_VALUES = new Set(["unspecified", "unset", "false"]);

function parseCheckAttrOutput(out) {
  const parts = out.split("\0");
  const excluded = new Set();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (!ATTR_NEGATIVE_VALUES.has(parts[i + 2])) excluded.add(parts[i]);
  }
  return excluded;
}

// 変更ファイルを「レビュー対象（kept）」と「除外（excluded）」に分類する純粋関数。
// 除外条件: デフォルト glob にマッチ、または .gitattributes の linguist 属性
// （generated/vendored/documentation）が付いている。
// attrExcludedSet / defaultGlobs を注入可能にして FS/プロセス非依存にテストする。
function classifyFiles(
  files,
  { attrExcludedSet = new Set(), defaultGlobs = DEFAULT_EXCLUDE_GLOBS } = {}
) {
  const kept = [];
  const excluded = [];
  for (const file of files) {
    if (fileMatchesPatterns(file, defaultGlobs) || attrExcludedSet.has(file)) {
      excluded.push(file);
    } else {
      kept.push(file);
    }
  }
  return { kept, excluded };
}

// 除外パス配列から、diff 取得コマンド向けの除外引数を組み立てる純粋関数。
// SKILL 側はこれを jq で取り出してコマンドへそのまま連結する（LLM に組み立てさせない）。
//   git: `git diff <diffArgs> -- . ':(exclude)p1' ':(exclude)p2' ...`
// diff 取得は PR/local 両モードともローカル git diff に統一されたため、git キーのみ。
function buildExcludeArgs(excludedFiles) {
  if (excludedFiles.length === 0) return { git: [] };
  const git = ["--", ".", ...excludedFiles.map((p) => `:(exclude)${p}`)];
  return { git };
}

// kept ファイルを、変更行数（added+deleted）が maxLines を「超える」oversized と、それ以外の
// changedFiles に単一ループで振り分ける純粋関数（classifyFiles と同じ2バケット push 方式）。
// perFile は collectChangedLines が返す「numstat 生パス → { added, deleted }」の Map。
// 境界（ちょうど maxLines）はレビュー対象に残す（strictly greater）。numstat 側にしか現れない
// rename 生パス等は kept に無い＝perFile.get が undefined なので oversized 判定から漏れる（安全側）。
function splitOversized(keptFiles, perFile, maxLines) {
  const changedFiles = [];
  const oversizedFiles = [];
  for (const f of keptFiles) {
    const stat = perFile.get(f);
    const lines = stat ? stat.added + stat.deleted : null;
    (lines != null && lines > maxLines ? oversizedFiles : changedFiles).push(f);
  }
  return { changedFiles, oversizedFiles: oversizedFiles.sort() };
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
function buildAssignments(changedFiles, allRules, resolveRules = rulesForFile, tier = "normal") {
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

  if (tier !== "normal") {
    // fast-path（tiny/small）: ルール準拠チェックを1エージェントに寄せる。
    // 全グループのファイルを buckets[0] に集約し buckets[1] を空にする
    // （→ review-core の「assignments[1].files が空ならエージェント2を起動しない」条件が
    //   自動的に成立し、プロンプト側の変更なしにエージェント2起動が抑止される）。
    // tiny/small は総ファイル数がしきい値以内（small で最大5）なので1体が読むルール量も限定的。
    for (const g of groups) place(buckets[0], g, g.files);
  } else if (groups.length === 1) {
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
  let rawFiles;
  if (opts.mode === "pr") {
    try {
      range = resolvePrBaseRange(opts.pr);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    rawFiles = getChangedFilesFromRange(range);
  } else {
    // 引数なし実行 かつ ステージ済み変更あり → staged モード（コミット前レビュー）。
    // それ以外は range を解決する。range の有無で staged / range を判別する。
    const staged = opts.range ? [] : getStagedFiles();
    if (staged.length > 0) {
      rawFiles = staged;
    } else {
      range = resolveRange(opts.range);
      rawFiles = getChangedFilesFromRange(range);
    }
  }

  // レビュー対象外（生成物・バイナリ・linguist 属性付き）を機械的に除外する。
  // 除外したファイルは excludedFiles として明示し、暗黙のスキップにしない。
  // 先にデフォルト glob で除外できるものを外し、残りだけ git check-attr に問い合わせる
  // （バイナリ多数の diff で check-attr へ渡すパスを減らす）。
  const globSurvivors = rawFiles.filter(
    (f) => !fileMatchesPatterns(f, DEFAULT_EXCLUDE_GLOBS)
  );
  const attrExcludedSet = detectLinguistExcluded(globSurvivors);
  const { kept: keptFiles, excluded: excludedFiles } = classifyFiles(rawFiles, {
    attrExcludedSet,
  });

  const diffArgs = range ? [range] : ["--staged"];

  // まず「生成物/バイナリのみ除外」した diff で numstat を取り、ファイル別行数を得る。
  // この perFile から oversized（1ファイルが巨大な変更）を分離する。行数集計は同じ出力から
  // 得られるので numstat は1回だけ（追加コストなし）。
  const lineStats = collectChangedLines(diffArgs, buildExcludeArgs(excludedFiles).git);
  const { changedFiles, oversizedFiles } = splitOversized(
    keptFiles,
    lineStats.perFile,
    OVERSIZED_MAX_LINES
  );

  const rules = await collectRules(changedFiles);

  // 最終の除外引数は excludedFiles（生成物/バイナリ）と oversizedFiles（大規模）の両方を含む。
  // 以降の diff 取得・アンカー解決はすべてこの excludeArgs.git を経由するため、oversized は
  // 全 diff から一様に消える（emit-diff / diff-anchor は無改修で整合する）。
  const excludeArgs = buildExcludeArgs([...excludedFiles, ...oversizedFiles]);

  // メトリクス・tier は oversized を除いた「実際にレビューする」規模で確定する。
  // oversized 分の行数は上の numstat（perFile）から減算するだけで求まるため git は再実行しない。
  // oversized は kept と照合済みで perFile に必ず存在し、バイナリ行は perFile に載らないので
  // 減算に混入しない。ファイル数は changedFiles.length（oversized 除外後）。
  let oversizedAdded = 0;
  let oversizedDeleted = 0;
  for (const f of oversizedFiles) {
    const stat = lineStats.perFile.get(f);
    oversizedAdded += stat.added;
    oversizedDeleted += stat.deleted;
  }
  const totalAdded = lineStats.totalAdded - oversizedAdded;
  const totalDeleted = lineStats.totalDeleted - oversizedDeleted;
  const metrics = {
    totalFiles: changedFiles.length,
    totalAdded,
    totalDeleted,
    totalChangedLines: totalAdded + totalDeleted,
  };
  const tier = classifyTier(metrics.totalFiles, metrics.totalChangedLines);

  // tier に応じてルール準拠エージェントの割り当てを縮退させる
  // （tiny/small は buckets[1] を空にして2体目の起動を抑止する）。
  const assignments = buildAssignments(changedFiles, rules, undefined, tier);

  // source は全モードで出力する。PR モードもローカル range に統一されたため、diffArgs /
  // range を持つ（PR は `<baseRefOid>...HEAD`、staged は `--staged`）。
  const source = opts.mode === "pr" ? "pr" : range ? "range" : "staged";
  const output = {
    source,
    changedFiles,
    excludedFiles,
    // 変更行数が閾値超で個別レビューが困難と判断し、レビュー対象から外したファイル。
    // excludedFiles（生成物/バイナリ）とは除外理由が異なる別枠。excludeArgs.git にも含まれる。
    oversizedFiles,
    // 各 diff 取得コマンド向けの除外引数（SKILL 側は jq で取り出して連結するだけ）。
    excludeArgs,
    assignments,
    // 変更規模と tier（プロンプトはこの tier を jq で読み、起動エージェント数を決める）。
    metrics,
    tier,
    // diffArgs は後続の `git diff <diffArgs>` 用引数（全モードで SKILL 側の差分取得を一様化）。
    diffArgs,
  };
  // range は PR モードと range モードで存在する（staged モードでは存在しない）。
  if (range) output.range = range;

  // 出力は一時ファイルへ書き、そのパスだけを stdout に返す。後続ステップは jq で
  // このファイルから必要な値のみを取り出す（LLM に JSON を解釈させない）。
  // 1プロセス1ファイルなので pid で一意。ファイルは後続ステップが読み終わるまで
  // 残す必要があるため明示削除はせず、OS の一時ディレクトリ回収に委ねる。
  const outPath = path.join(tmpdir(), `code-review-context-${process.pid}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(outPath);
}

// ---- インラインテスト --------------------------------------------------------
// `node --test plugins/code-review/scripts/collect-review-context.mjs` で実行する。
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

  // ---- tier（変更規模）と fast-path 縮退 ----
  const buildTier = (files, tier) =>
    buildAssignments(files, [], fakeResolve, tier);

  test("classifyTier: tiny はファイル数 AND 行数の両方がしきい値未満", () => {
    assert.equal(classifyTier(2, 33), "tiny"); // PR #813 相当（2ファイル33行）
    assert.equal(classifyTier(1, 49), "tiny");
    assert.equal(classifyTier(2, 49), "tiny");
  });

  test("classifyTier: 一方でも超えたら tiny に該当しない", () => {
    assert.equal(classifyTier(3, 33), "small"); // ファイル数超過
    assert.equal(classifyTier(2, 50), "small"); // 行数超過（境界は < なので 50 は tiny 外）
  });

  test("classifyTier: small はファイル数 AND 行数の両方がしきい値未満", () => {
    assert.equal(classifyTier(5, 149), "small");
    assert.equal(classifyTier(3, 100), "small");
  });

  test("classifyTier: しきい値を超えたら normal", () => {
    assert.equal(classifyTier(6, 100), "normal"); // ファイル数超過
    assert.equal(classifyTier(5, 150), "normal"); // 行数超過
    assert.equal(classifyTier(20, 500), "normal");
  });

  test("buildAssignments: tiny は全ファイルを buckets[0] に寄せて buckets[1] を空にする", () => {
    // normal なら [2,2] になる4ファイル単一グループが、tiny では [4,0] に縮退する。
    const a = buildTier(["a.txt", "b.txt", "c.txt", "d.txt"], "tiny");
    assert.deepEqual(fileCounts(a), [4, 0]);
  });

  test("buildAssignments: small も複数グループを buckets[0] に集約する", () => {
    // normal なら骨格/filler で2バケットに割れる構成でも small は1バケットに寄る。
    const files = ["models/m0.rb", "migrate/g0.rb", "docs/d0.md"];
    const a = buildTier(files, "small");
    assert.equal(a[1].files.length, 0);
    assert.equal(a[0].files.length, 3);
  });

  test("buildAssignments: normal は従来どおり2バケットへ分割（後方互換）", () => {
    const a = buildTier(["a.txt", "b.txt", "c.txt", "d.txt"], "normal");
    assert.deepEqual(fileCounts(a), [2, 2]);
  });

  test("parseNumstat: added/deleted/path をパースし合計行数を出せる", () => {
    const out = "10\t5\tsrc/a.ts\n2\t0\tspec/b.rb\n";
    const rows = parseNumstat(out);
    assert.equal(rows.length, 2);
    const total = rows.reduce((s, r) => s + r.added + r.deleted, 0);
    assert.equal(total, 17);
  });

  test("parseNumstat: バイナリ行（- -）は added/deleted が null", () => {
    const out = "-\t-\tassets/logo.png\n3\t1\tsrc/a.ts\n";
    const rows = parseNumstat(out);
    assert.equal(rows[0].added, null);
    assert.equal(rows[0].deleted, null);
    assert.equal(rows[1].added, 3);
  });

  test("parseNumstat: 空行・不正行はスキップする", () => {
    const out = "\n5\t5\tsrc/a.ts\ngarbage\n";
    const rows = parseNumstat(out);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, "src/a.ts");
  });

  test("parseNumstat: rename 生パス（old => new）はそのまま path に入る", () => {
    // 正規化しない設計の確認（splitOversized 側の照合漏れ＝安全側挙動の前提）。
    const out = "10\t2\tsrc/old.rb => src/new.rb\n";
    const rows = parseNumstat(out);
    assert.equal(rows[0].path, "src/old.rb => src/new.rb");
    assert.equal(rows[0].added + rows[0].deleted, 12);
  });

  test("classifyFiles: デフォルト glob（ミニファイ/生成物/バイナリ）を除外する", () => {
    const files = [
      "src/app.js",
      "dist/bundle.js",
      "assets/app.min.js",
      "public/logo.png",
      "docs/guide.md",
    ];
    const { kept, excluded } = classifyFiles(files);
    assert.deepEqual(kept, ["src/app.js", "docs/guide.md"]);
    assert.deepEqual(excluded.sort(), [
      "assets/app.min.js",
      "dist/bundle.js",
      "public/logo.png",
    ]);
  });

  test("classifyFiles: SVG はテキスト diff として保持する", () => {
    const { kept, excluded } = classifyFiles(["icons/menu.svg"]);
    assert.deepEqual(kept, ["icons/menu.svg"]);
    assert.deepEqual(excluded, []);
  });

  test("classifyFiles: linguist 属性（attrExcludedSet 注入）を除外する", () => {
    const files = ["src/a.rb", "src/generated_schema.rb"];
    const attrExcludedSet = new Set(["src/generated_schema.rb"]);
    const { kept, excluded } = classifyFiles(files, { attrExcludedSet });
    assert.deepEqual(kept, ["src/a.rb"]);
    assert.deepEqual(excluded, ["src/generated_schema.rb"]);
  });

  test("parseCheckAttrOutput: 値ごとの除外判定（無効値以外は除外）", () => {
    // 設定値（set/true/任意の値）→ 除外、無効値（unspecified/unset/false）→ 除外しない
    const cases = [
      ["set", true], // 値なし記法（`path linguist-generated`）
      ["true", true], // `=true`
      ["1", true], // `=1`（linguist は打ち消し以外の設定値を有効扱い）
      ["yes", true], // `=yes`
      ["unspecified", false], // 属性なし
      ["unset", false], // `-attr` で打ち消し
      ["false", false], // `=false`
    ];
    for (const [value, excluded] of cases) {
      const out = `f.rb\0linguist-generated\0${value}\0`;
      assert.deepEqual(
        [...parseCheckAttrOutput(out)],
        excluded ? ["f.rb"] : [],
        `value=${value}`
      );
    }
  });

  test("parseCheckAttrOutput: 3属性が並び、いずれか設定値なら含める", () => {
    // vendor/x.rb は vendored のみ set、他2属性は unspecified
    const out =
      "vendor/x.rb\0linguist-generated\0unspecified\0" +
      "vendor/x.rb\0linguist-vendored\0set\0" +
      "vendor/x.rb\0linguist-documentation\0unspecified\0";
    assert.deepEqual([...parseCheckAttrOutput(out)], ["vendor/x.rb"]);
  });

  test("parseCheckAttrOutput: 空出力は空 Set", () => {
    assert.deepEqual([...parseCheckAttrOutput("")], []);
  });

  test("classifyFiles: defaultGlobs を注入してテストできる", () => {
    const { kept, excluded } = classifyFiles(["a.gen", "b.rb"], {
      defaultGlobs: ["**/*.gen"],
    });
    assert.deepEqual(kept, ["b.rb"]);
    assert.deepEqual(excluded, ["a.gen"]);
  });

  test("buildExcludeArgs: 空配列なら git は空", () => {
    assert.deepEqual(buildExcludeArgs([]), { git: [] });
  });

  test("buildExcludeArgs: 複数パスを git 向け引数に組み立てる", () => {
    const args = buildExcludeArgs(["dist/a.js", "b.png"]);
    assert.deepEqual(args.git, [
      "--",
      ".",
      ":(exclude)dist/a.js",
      ":(exclude)b.png",
    ]);
  });

  // ---- oversized（単一巨大ファイル）分離 ----
  // perFile の値は { added, deleted }（変更行数 = added + deleted で判定）。
  const stat = (total) => ({ added: total, deleted: 0 });
  test("splitOversized: 閾値を超えたファイルだけ分離し、境界（= 閾値）は残す", () => {
    const kept = ["a.rb", "b.rb", "c.rb"];
    const perFile = new Map([
      ["a.rb", stat(1001)], // 超過 → oversized
      ["b.rb", stat(1000)], // ちょうど → レビュー対象に残す（strictly greater）
      ["c.rb", stat(10)], // 通常
    ]);
    const { changedFiles, oversizedFiles } = splitOversized(kept, perFile, 1000);
    assert.deepEqual(oversizedFiles, ["a.rb"]);
    assert.deepEqual(changedFiles, ["b.rb", "c.rb"]);
  });

  test("splitOversized: added+deleted の合算で閾値判定する", () => {
    const kept = ["a.rb"];
    const perFile = new Map([["a.rb", { added: 600, deleted: 500 }]]); // 合計 1100 > 1000
    const { oversizedFiles } = splitOversized(kept, perFile, 1000);
    assert.deepEqual(oversizedFiles, ["a.rb"]);
  });

  test("splitOversized: perFile に無い kept（照合漏れ・rename 生パス等）はレビュー対象に残す", () => {
    // numstat が rename を `old => new` で出し kept の新パスと一致しないケースの安全側挙動。
    const kept = ["src/renamed.rb"];
    const perFile = new Map([["src/old.rb => src/renamed.rb", stat(5000)]]);
    const { changedFiles, oversizedFiles } = splitOversized(kept, perFile, 1000);
    assert.deepEqual(oversizedFiles, []);
    assert.deepEqual(changedFiles, ["src/renamed.rb"]);
  });

  test("splitOversized: oversized は sort 済み配列で返る", () => {
    const kept = ["z.rb", "a.rb"];
    const perFile = new Map([
      ["z.rb", stat(2000)],
      ["a.rb", stat(2000)],
    ]);
    const { oversizedFiles } = splitOversized(kept, perFile, 1000);
    assert.deepEqual(oversizedFiles, ["a.rb", "z.rb"]);
  });

  test("splitOversized: 全ファイルが oversized なら changedFiles は空", () => {
    const kept = ["a.rb", "b.rb"];
    const perFile = new Map([
      ["a.rb", stat(3000)],
      ["b.rb", stat(3000)],
    ]);
    const { changedFiles, oversizedFiles } = splitOversized(kept, perFile, 1000);
    assert.deepEqual(changedFiles, []);
    assert.deepEqual(oversizedFiles, ["a.rb", "b.rb"]);
  });

  test("splitOversized→buildExcludeArgs: excluded と oversized の両方が :(exclude) に入る", () => {
    // main のフロー相当（生成物除外 + 大規模除外を1つの excludeArgs にまとめる）。
    const excludedFiles = ["dist/bundle.js"];
    const kept = ["src/big.rb", "src/small.rb"];
    const perFile = new Map([
      ["src/big.rb", stat(2000)],
      ["src/small.rb", stat(20)],
    ]);
    const { oversizedFiles } = splitOversized(kept, perFile, 1000);
    const args = buildExcludeArgs([...excludedFiles, ...oversizedFiles]);
    assert.deepEqual(args.git, [
      "--",
      ".",
      ":(exclude)dist/bundle.js",
      ":(exclude)src/big.rb",
    ]);
  });

  // resolvePrBaseRange: exec を関数注入スタブ化し、実 gh/git を呼ばずに検証する。
  // stub は (cmd, args) を受け取り、想定コマンドに応じた文字列を返す/throw する。
  test("resolvePrBaseRange: 正常系は <baseRefOid>...HEAD を返す", () => {
    const exec = (cmd, args) => {
      if (cmd === "gh") {
        return JSON.stringify({ baseRefOid: "abc123", baseRefName: "main" });
      }
      // git cat-file / merge-base はどちらも成功（空文字返却）
      return "";
    };
    assert.equal(resolvePrBaseRange("7", { exec }), "abc123...HEAD");
  });

  test("resolvePrBaseRange: base コミット不在は fetch 指示を含めて throw", () => {
    const exec = (cmd, args) => {
      if (cmd === "gh") {
        return JSON.stringify({ baseRefOid: "abc123", baseRefName: "main" });
      }
      if (cmd === "git" && args[0] === "cat-file") {
        throw new Error("not found");
      }
      return "";
    };
    assert.throws(() => resolvePrBaseRange("7", { exec }), (err) => {
      assert.match(err.message, /git fetch origin main/);
      return true;
    });
  });

  test("resolvePrBaseRange: merge-base 不能（shallow）は --unshallow を含めて throw", () => {
    const exec = (cmd, args) => {
      if (cmd === "gh") {
        return JSON.stringify({ baseRefOid: "abc123", baseRefName: "main" });
      }
      if (cmd === "git" && args[0] === "merge-base") {
        throw new Error("shallow");
      }
      return "";
    };
    assert.throws(() => resolvePrBaseRange("7", { exec }), (err) => {
      assert.match(err.message, /--unshallow/);
      return true;
    });
  });

  test("resolvePrBaseRange: baseRefOid 欠落は throw", () => {
    const exec = (cmd) => {
      if (cmd === "gh") return JSON.stringify({ baseRefName: "main" });
      return "";
    };
    assert.throws(() => resolvePrBaseRange("7", { exec }), /baseRefOid/);
  });

  test("resolvePrBaseRange: 不正 JSON は throw", () => {
    const exec = (cmd) => {
      if (cmd === "gh") return "not json";
      return "";
    };
    assert.throws(() => resolvePrBaseRange("7", { exec }));
  });
}
