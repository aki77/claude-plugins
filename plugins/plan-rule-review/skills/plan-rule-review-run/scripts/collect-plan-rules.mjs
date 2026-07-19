#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";

// プランから本体が抽出した「変更対象ファイルパス」を引数で受け取り、
// それらに該当する CLAUDE.md / .claude/rules/ のパス一覧だけを JSON で出力する。
// gh pr diff には依存しない（プラン段階では確定した diff が存在しないため）。
//
// グローバルルール（ルート直下の CLAUDE.md、および .claude/rules/ で paths 未指定＝
// 全ファイル適用のルール）は常に除外する。これらは確実に読み込み済みでプランに反映されて
// いる可能性が高く、レビューが無駄になりやすいため。出力はディレクトリ階層由来の CLAUDE.md と、
// paths が変更対象ファイルに一致した paths 指定ルールのみ。
const changedFiles = process.argv
  .slice(2)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.split(path.sep).join("/"));

if (changedFiles.length === 0) {
  console.error(
    "Usage: collect-plan-rules.mjs <file1> [file2 ...]\n" +
      "  プランの変更対象ファイルパスを1つ以上渡してください。"
  );
  process.exit(1);
}

const cwd = process.cwd();

function collectClaudeMd(files) {
  const results = new Set();
  for (const file of files) {
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

// 抽出済みのファイルパス文字列を glob パターンと直接照合する。
// ファイルシステムを走査しないため、まだ存在しない新規作成予定のファイルでもマッチできる。
function anyChangedFileMatches(patterns, files) {
  for (const pattern of patterns) {
    for (const file of files) {
      if (path.matchesGlob(file, pattern)) return true;
    }
  }
  return false;
}

async function collectRules(files) {
  const ruleFiles = await listRuleFiles();
  const results = [];
  for (const file of ruleFiles) {
    const content = readFileSync(path.join(cwd, file), "utf8");
    // paths 未指定（null）・空配列はグローバル扱いで除外し、
    // paths 指定かつ変更対象ファイルに一致したものだけを含める。
    const paths = parseFrontmatterPaths(content);
    if (paths && paths.length > 0 && anyChangedFileMatches(paths, files)) {
      results.push({ path: file, paths });
    }
  }
  return results;
}

const claudeMd = collectClaudeMd(changedFiles);
const rules = await collectRules(changedFiles);

console.log(JSON.stringify({ claudeMd, rules }, null, 2));
