// 中間成果物（CTX / CLUSTERS / FINDINGS / ISSUES / FINAL）の共通 I/O モジュール。
//
// collect-review-context.mjs が確立した規約「結果を一時ファイルに JSON で書き、その
// パスだけを stdout に1行返す。後続ステップは jq で必要な値のみ取り出す」を、レビュー
// パイプラインの全スクリプトで共有するために切り出したもの。LLM に大きな JSON を
// 解釈させず、値の受け渡しをファイルパス経由に統一する（決定論化の土台）。
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// stdin（fd 0）を同期で最後まで読み、JSON としてパースする。パイプ・リダイレクト双方で
// 動く。stdin が空/読めない場合は空文字を JSON.parse して例外にする（呼び出し側が
// 「stdin が不正」として扱えるよう、握り潰さず throw させる）。
export function readStdinJson() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  return JSON.parse(raw);
}

// obj を一時ファイル `tmpdir()/code-review-<name>-<pid>.json` に書き、そのパスを返す。
// 1プロセス1ファイルなので pid で一意。ファイルは後続ステップが読み終わるまで残す
// 必要があるため明示削除はせず、OS の一時ディレクトリ回収に委ねる（CTX と同一方針）。
export function writeArtifact(name, obj) {
  const outPath = path.join(tmpdir(), `code-review-${name}-${process.pid}.json`);
  writeFileSync(outPath, JSON.stringify(obj, null, 2));
  return outPath;
}

// 成果物ファイル（CTX 等）を読んで JSON パースする薄いヘルパ。読み込み失敗は
// actionable なメッセージを付けて throw する。
export function readArtifact(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(`成果物ファイルの読み込みに失敗しました（${filePath}）: ${e.message}`);
  }
  return JSON.parse(raw);
}

// `Error: <msg>` を stderr に出して exit 1 する。各スクリプトの main が繰り返していた
// `console.error(...); process.exit(1)` を1か所に集約する（エラー表記の統一）。
export function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// `--flag value` 形式の引数を機械パースする共通ヘルパ。各スクリプトが手書きしていた
// argv ループ + usage/exit 定型を一本化する。
//   spec.flags    : 受理する `--flag` 名の配列（値を1つ取る）。
//   spec.required : 必須フラグ名の配列（欠落なら usage を出して exit 1）。
//   spec.usage    : 使い方の1行説明。
// 戻り値: フラグ名から `--` を除いた camel 相当キー（例: `--context` → `context`）のオブジェクト。
export function parseFlags(argv, { flags, required = [], usage }) {
  const args = argv.slice(2);
  const key = (flag) => flag.replace(/^--/, "");
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flags.includes(flag) && args[i + 1] != null) {
      out[key(flag)] = args[++i];
    }
  }
  if (required.some((flag) => out[key(flag)] == null)) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  return out;
}
