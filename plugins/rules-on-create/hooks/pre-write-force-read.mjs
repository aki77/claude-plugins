#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { readFile, glob } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

export function parseFrontmatterPaths(content) {
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
      const indent = line.match(/^(\s*)/)[1].length;
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

function findProjectRoot(start) {
  let dir = start;
  while (true) {
    if (existsSync(path.join(dir, ".claude")) || existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function globToRegExp(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i++;
      } else {
        const alts = pattern.slice(i + 1, end).split(",").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        re += `(?:${alts})`;
        i = end + 1;
      }
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
        i++;
      } else {
        re += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

async function listRuleFiles(projectRoot) {
  const rulesDir = path.join(projectRoot, ".claude/rules");
  const matches = [];
  try {
    for await (const entry of glob("**/*.md", { cwd: rulesDir })) {
      matches.push(path.join(rulesDir, entry));
    }
  } catch {
    // rulesDir が存在しない場合など
  }
  return matches;
}

async function matchesAnyRule(projectRoot, targetRel) {
  const ruleFiles = await listRuleFiles(projectRoot);
  for (const ruleFile of ruleFiles) {
    const content = await readFile(ruleFile, "utf-8");
    const patterns = parseFrontmatterPaths(content);
    if (!patterns || patterns.length === 0) continue;
    for (const pattern of patterns) {
      if (globToRegExp(pattern).test(targetRel)) return true;
    }
  }
  return false;
}

function hasAncestorClaudeMd(projectRoot, targetRel) {
  let dir = path.posix.dirname(targetRel.split(path.sep).join("/"));
  while (dir !== ".") {
    const claudeMdPath = path.join(projectRoot, dir, "CLAUDE.md");
    if (existsSync(claudeMdPath)) return true;
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

async function main() {
  const raw = await readStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = payload?.tool_input?.file_path;
  if (!filePath || typeof filePath !== "string") process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const absTarget = path.resolve(cwd, filePath);

  let stat;
  try {
    stat = lstatSync(absTarget);
  } catch {
    stat = null;
  }
  if (stat !== null) process.exit(0);

  const projectRoot = findProjectRoot(path.dirname(absTarget));
  if (!projectRoot) process.exit(0);

  const targetRel = path.relative(projectRoot, absTarget);
  if (targetRel.startsWith("..")) process.exit(0);

  const targetRelPosix = targetRel.split(path.sep).join("/");
  if (!await matchesAnyRule(projectRoot, targetRelPosix) && !hasAncestorClaudeMd(projectRoot, targetRel)) process.exit(0);

  mkdirSync(path.dirname(absTarget), { recursive: true });
  writeFileSync(absTarget, "");

  const reason = `File '${filePath}' did not exist. It was created empty. Path-based rules may apply but are only loaded on Read. You MUST Read this file first (to load rules), then Write/Edit with the discovered rules.`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

if (!process.env.NODE_TEST_CONTEXT) {
  main().catch(() => process.exit(0));
}

// ---- インラインテスト --------------------------------------------------------
// `node --test plugins/rules-on-create/hooks/pre-write-force-read.mjs` で実行する。
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  test("parseFrontmatterPaths: frontmatter 無しは null", () => {
    assert.equal(parseFrontmatterPaths("hello\nworld"), null);
  });

  test("parseFrontmatterPaths: インライン配列はクォートを除去して収集", () => {
    assert.deepEqual(
      parseFrontmatterPaths('---\npaths: ["a/**", \'b.ts\']\n---\n本文'),
      ["a/**", "b.ts"]
    );
  });

  test("parseFrontmatterPaths: ブロックリストは各項目を収集しクォートを除去", () => {
    assert.deepEqual(
      parseFrontmatterPaths('---\npaths:\n  - "a/**"\n  - b.ts\n---\n本文'),
      ["a/**", "b.ts"]
    );
  });

  test("parseFrontmatterPaths: paths キーはあるが値も配下項目も無いときは空配列", () => {
    assert.deepEqual(parseFrontmatterPaths("---\npaths:\n---\n本文"), []);
  });

  test("parseFrontmatterPaths: frontmatter 内に paths キーが無ければ null", () => {
    assert.equal(parseFrontmatterPaths("---\ntitle: x\n---\n本文"), null);
  });

  test("parseFrontmatterPaths: paths と同じかそれより浅いインデントの別キーで収集を打ち切る", () => {
    assert.deepEqual(
      parseFrontmatterPaths(
        "---\npaths:\n  - a\n  - b\nother: y\n  - c\n---\n本文"
      ),
      ["a", "b"]
    );
  });

  test("parseFrontmatterPaths: 開き --- はあるが閉じ --- が無ければ null", () => {
    assert.equal(
      parseFrontmatterPaths("---\npaths:\n  - a\n本文（閉じタグ無し）"),
      null
    );
  });

  test("globToRegExp: * は / を跨がない", () => {
    const re = globToRegExp("src/*.ts");
    assert.equal(re.test("src/a.ts"), true);
    assert.equal(re.test("src/a/b.ts"), false);
  });

  test("globToRegExp: ** は / を跨ぐ", () => {
    const re = globToRegExp("src/**/*.ts");
    assert.equal(re.test("src/a/b.ts"), true);
  });

  test("globToRegExp: ? は 1 文字にマッチし / にはマッチしない", () => {
    const re = globToRegExp("a?.ts");
    assert.equal(re.test("a1.ts"), true);
    assert.equal(re.test("a/.ts"), false);
  });

  test("globToRegExp: {ts,tsx} の展開でどちらにもマッチする", () => {
    const re = globToRegExp("*.{ts,tsx}");
    assert.equal(re.test("x.ts"), true);
    assert.equal(re.test("x.tsx"), true);
    assert.equal(re.test("x.js"), false);
  });

  test("globToRegExp: 文字クラスがそのまま機能する", () => {
    const re = globToRegExp("[abc].ts");
    assert.equal(re.test("a.ts"), true);
    assert.equal(re.test("d.ts"), false);
  });

  test("globToRegExp: 正規表現メタ文字はリテラル扱いされる", () => {
    const re = globToRegExp("a.ts");
    assert.equal(re.test("axts"), false);
  });

  test("globToRegExp: 先頭・末尾がアンカーされ部分一致しない", () => {
    const re = globToRegExp("foo.ts");
    assert.equal(re.test("xfoo.tsx"), false);
  });
}
