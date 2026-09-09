#!/usr/bin/env node
// usage-guard のバイパス（一時解除）を設定・解除する。
// enforce モードで閾値超過中は UserPromptSubmit フックが全プロンプトをブロックするため、
// このスクリプト自身は "/usage-guard" 前方一致の免除（guard-shared.mjs の isExemptPrompt）
// によって常に実行できる。
import {
  resolveBypassPath,
  resolveCachePath,
  readJson,
  writeJsonAtomic,
  parseDuration,
  formatResetAt,
} from "../../../hooks/guard-shared.mjs";

function main() {
  const env = process.env;
  const nowSec = Math.floor(Date.now() / 1000);
  const arg = process.argv[2];

  const cache = readJson(resolveCachePath(env));
  const parsed = parseDuration(arg, cache, nowSec);

  if (!parsed) {
    if (String(arg ?? "").trim().toLowerCase() === "reset") {
      // reset が使えない原因は「未取得」だけではない（cache はあるが five_hour だけ
      // 欠落しているケースもある）。原因を断定せず、事実だけを伝える。
      console.log(
        "5時間枠のリセット時刻が不明なため reset は使えません。" +
          "使用量データが未取得か、5時間枠の情報が欠けています。" +
          "現在の状態は /usage-guard:usage-guard-status で確認できます。"
      );
      console.log("代わりに 30m のように期間を直接指定してください。");
    } else {
      console.log(`引数が不正です: ${arg}`);
    }
    console.log(
      "使い方: 30m（分） / 2h（時間） / 90（分として解釈） / reset（5時間枠のリセットまで） / off（解除）"
    );
    process.exit(1);
  }

  const bypassPath = resolveBypassPath(env);
  const ok = writeJsonAtomic(bypassPath, {
    version: 1,
    until: parsed.until,
    set_at: nowSec,
    note: parsed.label,
  });

  if (!ok) {
    console.log("バイパスの書き込みに失敗しました");
    process.exit(1);
  }

  if (parsed.label === "off") {
    console.log("usage-guard バイパスを解除しました");
  } else {
    console.log(`usage-guard バイパスを有効化しました: ${formatResetAt(parsed.until, nowSec)}`);
  }
}

main();
