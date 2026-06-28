#!/usr/bin/env node
// プラン内 Ruby コードブロックを RuboCop で検証するラッパ。
//
// 入力（stdin, JSON）:
//   { "blocks": [ { "path": "app/models/article.rb", "code": "class Article ..." }, ... ] }
//   - path: そのコードの本来の配置パス（リポジトリルート相対）。`--stdin` に渡す。
//   - code: 検証する Ruby ソース全文。
//
// 動作:
//   検証先プロジェクトのルート（カレントディレクトリ＝.rubocop.yml がある場所）で
//   各ブロックを `bundle exec rubocop --stdin <path> --format json --force-exclusion` で検証する。
//   ファイルは一切作成・変更しない（--stdin はメモリ上で評価する）。
//
// 出力（stdout, JSON）:
//   {
//     "rubocopAvailable": true,
//     "results": [
//       { "path": "...", "offenseCount": 2, "offenses": [ { "cop": "...", "message": "...", "line": N, "column": N, "severity": "..." } ] },
//       ...
//     ],
//     "totalOffenses": 2
//   }
//   rubocop が使えない場合: { "rubocopAvailable": false, "reason": "..." }
//
// 終了コード:
//   0 = 正常に検証を実行できた（違反の有無に関わらず）
//   2 = rubocop が使えない / 入力不正（呼び出し側は素通し扱いにしてよい）

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function readAllStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function checkRubocopAvailable() {
  const res = spawnSync("bundle", ["exec", "rubocop", "--version"], {
    encoding: "utf-8",
  });
  return res.status === 0;
}

function runRubocop(code, filePath) {
  const res = spawnSync(
    "bundle",
    [
      "exec",
      "rubocop",
      "--stdin",
      filePath,
      "--format",
      "json",
      "--force-exclusion",
    ],
    { input: code, encoding: "utf-8" }
  );

  // rubocop は違反ありで status 1、内部エラーで 2 を返す。
  // いずれの場合も JSON は stdout に出る想定だが、パース失敗時は raw を返す。
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = null;
  }

  if (!parsed || !Array.isArray(parsed.files)) {
    return {
      path: filePath,
      error: true,
      offenseCount: 0,
      offenses: [],
      raw: (res.stdout || "") + (res.stderr || ""),
    };
  }

  const offenses = [];
  for (const f of parsed.files) {
    for (const o of f.offenses || []) {
      offenses.push({
        cop: o.cop_name,
        message: o.message,
        line: o.location?.start_line ?? o.location?.line ?? null,
        column: o.location?.start_column ?? o.location?.column ?? null,
        severity: o.severity,
        correctable: o.correctable ?? null,
      });
    }
  }

  return {
    path: filePath,
    error: false,
    offenseCount: offenses.length,
    offenses,
  };
}

function main() {
  const raw = readAllStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.log(
      JSON.stringify({ rubocopAvailable: false, reason: "invalid JSON input" })
    );
    process.exit(2);
  }

  const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
  if (blocks.length === 0) {
    console.log(
      JSON.stringify({ rubocopAvailable: false, reason: "no blocks provided" })
    );
    process.exit(2);
  }

  if (!checkRubocopAvailable()) {
    console.log(
      JSON.stringify({
        rubocopAvailable: false,
        reason: "`bundle exec rubocop` is not available in this project",
      })
    );
    process.exit(2);
  }

  const results = [];
  let totalOffenses = 0;
  for (const b of blocks) {
    if (!b || typeof b.path !== "string" || typeof b.code !== "string") {
      continue;
    }
    const r = runRubocop(b.code, b.path);
    results.push(r);
    totalOffenses += r.offenseCount;
  }

  console.log(
    JSON.stringify({ rubocopAvailable: true, results, totalOffenses }, null, 2)
  );
  process.exit(0);
}

main();
