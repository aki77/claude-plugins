#!/usr/bin/env node
// usage-guard の現在状態を人間可読な日本語テキストで表示する。
// 重要: JSON を出さない理由 -- 閾値超過中は直後の PostToolBatch フックがブロックするため、
// モデルが出力を整形してユーザーへリレーできない可能性がある。生のツール結果として
// そのまま読めるテキストである必要がある（SKILL.md 側も「そのまま提示」と指示している）。
import {
  resolveConfigPath,
  resolveCachePath,
  resolveBypassPath,
  readJson,
  loadConfig,
  evaluate,
  isBypassActive,
  formatDuration,
  formatAbsTime,
  formatResetAt,
  WINDOW_LABELS,
} from "../../../hooks/guard-shared.mjs";

// ラベルの桁を揃える。全角スペースでの padEnd は「文字数」で数えるため、
// 全角/半角が混在するラベル（例: "5時間枠" は半角1+全角3）だと表示幅がずれる。
// 端末上の見た目を揃えるには文字数ではなく表示幅（全角2/半角1）で埋める必要がある。
function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    w += /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function padDisplay(str, width) {
  return str + " ".repeat(Math.max(0, width - displayWidth(str)));
}

function main() {
  const env = process.env;
  const nowSec = Math.floor(Date.now() / 1000);

  const config = loadConfig(env);
  const configPath = resolveConfigPath(env);
  const cache = readJson(resolveCachePath(env));
  const bypass = readJson(resolveBypassPath(env));

  const lines = [];
  lines.push("usage-guard 状態");
  lines.push(`  mode: ${config.mode}  (${configPath})`);

  if (!cache) {
    lines.push(
      "  使用量データがまだ取得されていません（セッション最初のフック実行時に取得されます）。ガードは fail-open で許可します。"
    );
  } else {
    for (const key of Object.keys(WINDOW_LABELS)) {
      const label = padDisplay(WINDOW_LABELS[key], 8);
      const win = cache.windows && typeof cache.windows === "object" ? cache.windows[key] : null;
      const threshold = config.thresholds?.[key];
      const thresholdText = typeof threshold === "number" ? `閾値 ${Math.round(threshold)}%` : "監視対象外";

      if (!win || typeof win !== "object" || typeof win.utilization !== "number") {
        lines.push(`  ${label} データなし   ${thresholdText}`);
        continue;
      }

      const util = `${Math.round(win.utilization)}%`.padStart(4);
      const resetsAt = win.resets_at;
      let resetText;
      if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) {
        resetText = "リセット時刻不明";
      } else if (resetsAt <= nowSec) {
        resetText = "リセット済み";
      } else {
        resetText = `リセット: ${formatResetAt(resetsAt, nowSec)}`;
      }

      lines.push(`  ${label} ${util} / ${thresholdText}   ${resetText}`);
    }
  }

  if (isBypassActive(bypass, nowSec)) {
    lines.push(`  バイパス: 有効（残り ${formatDuration(bypass.until - nowSec)}）`);
  } else {
    lines.push("  バイパス: なし");
  }

  if (typeof cache?.fetched_at === "number" && Number.isFinite(cache.fetched_at)) {
    const abs = formatAbsTime(cache.fetched_at);
    lines.push(`  キャッシュ更新: ${abs} (${formatDuration(nowSec - cache.fetched_at)}前)`);
  } else {
    lines.push("  キャッシュ更新: 不明");
  }

  const evaluation = evaluate({ cache, config, bypass, nowSec });
  let verdict;
  if (evaluation.action === "block") {
    verdict = "停止（enforce）";
  } else if (evaluation.action === "warn") {
    verdict = "警告（dry-run、実際には停止しません）";
  } else if (config.mode === "off") {
    verdict = "許可（mode: off）";
  } else if (isBypassActive(bypass, nowSec)) {
    verdict = "許可（バイパス中）";
  } else {
    verdict = "許可（超過なし）";
  }
  lines.push(`  判定: ${verdict}`);

  console.log(lines.join("\n"));
}

try {
  main();
} catch (err) {
  console.log(`状態の読み取りに失敗しました: ${err?.message ?? err}`);
}
