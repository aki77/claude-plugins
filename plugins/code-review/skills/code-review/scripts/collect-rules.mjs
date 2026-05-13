#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";

const prArg = process.argv[2];
if (!prArg) {
  console.error("Usage: collect-rules.mjs <PR>");
  process.exit(1);
}

const cwd = process.cwd();

function getChangedFiles(pr) {
  const out = execFileSync("gh", ["pr", "diff", pr, "--name-only"], {
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

const changedFiles = getChangedFiles(prArg);
const claudeMd = collectClaudeMd(changedFiles);
const rules = await collectRules(changedFiles);

console.log(JSON.stringify({ claudeMd, rules }, null, 2));
