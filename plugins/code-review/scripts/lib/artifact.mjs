// 中間成果物（CTX / CLUSTERS / FINDINGS / ISSUES / FINAL）の共通 I/O モジュール。
//
// collect-review-context.mjs が確立した規約「結果を一時ファイルに JSON で書き、その
// パスだけを stdout に1行返す。後続ステップは jq で必要な値のみ取り出す」を、レビュー
// パイプラインの全スクリプトで共有するために切り出したもの。LLM に大きな JSON を
// 解釈させず、値の受け渡しをファイルパス経由に統一する（決定論化の土台）。
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// エージェント／メインが生成した構造化 JSON を「ファイル経由」で受け取る入力ヘルパ。
// headless（claude-code-action）の Bash permission 静的解析は「brace と quote が混在
// するコマンド」を難読化とみなして拒否するため、JSON をコマンドライン・heredoc・
// パイプに載せられない。そこで JSON は Write ツールで /tmp に書き、そのパスを --infile
// で渡す（パス文字列は brace/quote を含まないので静的解析を通る）。infiles が空/未指定の
// ときは readStdinJson() にフォールバックする（local-review の対話実行では heredoc/パイプ
// が使えるため後方互換で残す）。入力の形に応じて次の2関数を使い分ける:

// 単一入力スクリプト用。--infile 1つ（複数来ても先頭）の JSON、無ければ stdin の JSON を
// そのまま返す（配列に包まない）。
export function readSingleInputJson(infiles) {
  if (infiles && infiles.length > 0) {
    return readArtifact(infiles[0]);
  }
  return readStdinJson();
}

// 複数入力を集約するスクリプト用。各 --infile の JSON を要素とする配列を返す。無ければ
// stdin の JSON を1要素配列に包んで返す（stdin では全入力を1本の配列にまとめて渡す運用）。
export function readInputJsonList(infiles) {
  if (infiles && infiles.length > 0) {
    return infiles.map((p) => readArtifact(p));
  }
  return [readStdinJson()];
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
//   spec.multi    : 同名を複数回受けて値を配列に集めるフラグ名の配列（例: `--infile a
//                   --infile b` → `["a", "b"]`）。省略時は従来どおり最後の値で上書き。
//   spec.usage    : 使い方の1行説明。
// 戻り値: フラグ名から `--` を除いた camel 相当キー（例: `--context` → `context`）のオブジェクト。
//   multi 指定のフラグは値が1つでも配列（1回も現れなければキー自体が未定義）。
export function parseFlags(argv, { flags, required = [], multi = [], usage }) {
  const args = argv.slice(2);
  const key = (flag) => flag.replace(/^--/, "");
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flags.includes(flag) && args[i + 1] != null) {
      const value = args[++i];
      if (multi.includes(flag)) {
        (out[key(flag)] ??= []).push(value);
      } else {
        out[key(flag)] = value;
      }
    }
  }
  if (required.some((flag) => out[key(flag)] == null)) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  return out;
}

// ---- インラインテスト --------------------------------------------------------
// `node --test plugins/code-review/scripts/lib/artifact.mjs` で実行する。
if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  const writeTmp = (name, obj) => {
    const p = path.join(tmpdir(), `artifact-test-${name}-${process.pid}.json`);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  test("parseFlags: multi 指定フラグは同名複数回を配列で集める", () => {
    const out = parseFlags(
      ["node", "s", "--context", "C", "--infile", "a.json", "--infile", "b.json"],
      { flags: ["--context", "--infile"], multi: ["--infile"], usage: "u" },
    );
    assert.equal(out.context, "C");
    assert.deepEqual(out.infile, ["a.json", "b.json"]);
  });

  test("parseFlags: multi フラグが1回でも配列、0回なら未定義", () => {
    const one = parseFlags(["node", "s", "--infile", "a.json"], {
      flags: ["--infile"],
      multi: ["--infile"],
      usage: "u",
    });
    assert.deepEqual(one.infile, ["a.json"]);
    const none = parseFlags(["node", "s"], {
      flags: ["--infile"],
      multi: ["--infile"],
      usage: "u",
    });
    assert.equal(none.infile, undefined);
  });

  test("parseFlags: multi 未指定フラグは従来どおり最後の値で上書き", () => {
    const out = parseFlags(["node", "s", "--x", "1", "--x", "2"], {
      flags: ["--x"],
      usage: "u",
    });
    assert.equal(out.x, "2");
  });

  test("readSingleInputJson: 単一 --infile はその JSON をそのまま返す", () => {
    const p = writeTmp("single", { id: 1, a: "x" });
    assert.deepEqual(readSingleInputJson([p]), { id: 1, a: "x" });
  });

  test("readInputJsonList: 複数 --infile は各ファイル JSON を順に配列で返す", () => {
    const p1 = writeTmp("multi1", [{ id: 1 }]);
    const p2 = writeTmp("multi2", [{ id: 2 }]);
    assert.deepEqual(readInputJsonList([p1, p2]), [[{ id: 1 }], [{ id: 2 }]]);
  });

  test("infiles が空/未指定なら両関数とも stdin へフォールバックする", () => {
    // stdin が無い環境では readStdinJson が JSON.parse("") で throw する。
    // ここでは「フォールバック経路に入る」ことだけを確認する（throw すれば経路に入った証左）。
    assert.throws(() => readSingleInputJson([]));
    assert.throws(() => readInputJsonList(undefined));
  });
}
