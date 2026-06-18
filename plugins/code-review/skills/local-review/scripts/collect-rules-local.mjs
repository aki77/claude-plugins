#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";

const rangeArg = process.argv[2];

const cwd = process.cwd();

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
      const base = execFileSync(
        "git",
        ["merge-base", baseBranch, "HEAD"],
        { encoding: "utf8" }
      ).trim();
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
    const base = execFileSync(
      "git",
      ["merge-base", "@{upstream}", "HEAD"],
      { encoding: "utf8" }
    ).trim();
    if (base) return `${base}...HEAD`;
  } catch {}

  // 4. origin/HEAD
  try {
    const base = execFileSync(
      "git",
      ["merge-base", "origin/HEAD", "HEAD"],
      { encoding: "utf8" }
    ).trim();
    if (base) return `${base}...HEAD`;
  } catch {}

  console.error(
    "Error: ベースブランチを自動解決できませんでした。\n" +
      "引数として範囲を明示してください。例: collect-rules-local.mjs main"
  );
  process.exit(1);
}

const range = resolveRange(rangeArg);

function getChangedFiles(range) {
  const out = execFileSync("git", ["diff", "--name-only", range], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function collectClaudeMd(changedFiles) {
  const results = new Set();
  if (existsSync(path.join(cwd, "CLAUDE.md"))) {
    results.add("CLAUDE.md");
  }
  for (const file of changedFiles) {
    let dir = path.dirname(file);
    while (dir && dir !== "." && dir !== "/") {
      const candidate = path.join(dir, "CLAUDE.md");
      if (existsSync(path.join(cwd, candidate))) {
        results.add(candidate);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...results].sort();
}

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
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;
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

async function anyChangedFileMatches(patterns, changedFiles) {
  for (const pattern of patterns) {
    for await (const match of glob(pattern, { cwd })) {
      const normalized = match.split(path.sep).join("/");
      if (changedFiles.includes(normalized)) return true;
    }
  }
  return false;
}

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
    } else if (await anyChangedFileMatches(paths, changedFiles)) {
      results.push({ path: file, paths });
    }
  }
  return results;
}

const changedFiles = getChangedFiles(range);
const claudeMd = collectClaudeMd(changedFiles);
const rules = await collectRules(changedFiles);

console.log(JSON.stringify({ range, changedFiles, claudeMd, rules }, null, 2));
