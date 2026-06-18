#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSIONS_FILE = path.join(os.tmpdir(), "plan-rule-review-sessions.json");
const TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_REVIEWS = 2;
const PASSED_MARKER = "<!-- plan-rule-review: passed -->";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function getMaxReviews() {
  const raw = process.env.PLAN_RULE_REVIEW_MAX;
  if (!raw) return DEFAULT_MAX_REVIEWS;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_REVIEWS;
}

function loadSessions(now) {
  let data = {};
  if (existsSync(SESSIONS_FILE)) {
    try {
      data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8")) || {};
    } catch {
      data = {};
    }
  }
  // 24h より古いエントリを除去
  for (const [id, entry] of Object.entries(data)) {
    if (!entry || typeof entry.ts !== "number" || now - entry.ts > TTL_MS) {
      delete data[id];
    }
  }
  return data;
}

function saveSessions(data) {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(data));
  } catch {
    // 書き込み失敗は無視（フックは Claude の動作を妨げない）
  }
}

function buildSubagentPrompt() {
  return [
    "あなたはプロジェクトルール準拠レビュー専用のレビュアーです。",
    "以下のプラン（実装計画）が、このリポジトリのプロジェクトルールに **違反していないか** だけを判定してください。",
    "",
    "前提:",
    "- すべてのツールは正常に動作する前提で使うこと。動作確認のための試し打ちはしない。",
    "- ファイルの読み込みは判定に必要な範囲のみ行う。",
    "",
    "レビュー対象のプラン全文:",
    "<<<PLAN",
    "（ここに本体がプラン全文をそのまま埋め込む）",
    "PLAN",
    "",
    "ルール読み込み手順:",
    "1. リポジトリルート直下の CLAUDE.md、およびプランで変更予定のファイルを含むディレクトリ・その祖先ディレクトリの CLAUDE.md を読む。",
    "2. `.claude/rules/` 配下のルールファイルのうち、(a) `paths` frontmatter が未指定（全ファイル適用）のもの、",
    "   (b) `paths` の glob パターンがプランの変更対象ファイルのいずれかに一致するもの、を読む。",
    "   - 変更対象ファイルが未確定な箇所はプラン記述から合理的に推測してよいが、明らかに無関係なルールは適用しない。",
    "",
    "判定観点:",
    "- プランがそれらルールに違反していないかのみを見る。バグ・一般的なコード品質・スタイルの懸念は対象外。",
    "- 該当ルールを引用できる、明白かつ明確な違反のみを高シグナルな指摘として扱う。",
    "- 確信が持てない指摘は行わない。誤検知はコストが高い。",
    "",
    "出力フォーマット（厳守。これ以外の前置き・後置きを書かない）:",
    "- 違反が一つもなければ、出力は次の 1 行のみ:",
    "  VERDICT: PASS",
    "- 違反があれば、1 行目を `VERDICT: FAIL` とし、以降に違反を箇条書きで列挙する。",
    "  各項目に「違反内容」「引用元ルールのファイルパスと該当記述」「プランのどの部分が違反か」を含める。",
    "",
    `重要: 出力に \`${PASSED_MARKER}\` という文字列を絶対に含めないこと（PASS でも FAIL でも）。判定は VERDICT 行で表現する。`,
  ].join("\n");
}

function buildReason() {
  return [
    "ExitPlanMode は plan-rule-review フックにより一旦ブロックされました。",
    "プランのプロジェクトルール準拠レビューは、あなた自身ではなく専用に起動するサブエージェントに行わせます。",
    "あなた（本体）はサブエージェントの判定を受け取り、それに従って対応するだけです。自分でルールを読んでレビューしないでください。",
    "",
    "手順:",
    "1. Task tool で general-purpose サブエージェントを 1 つだけ起動する。",
    "   サブエージェントには下記「サブエージェントへ渡すプロンプト」の内容を渡す。",
    "   プロンプト中の `<<<PLAN … PLAN` の間に、レビュー対象のプラン全文をそのまま埋め込むこと。",
    "2. サブエージェントの返答を待つ。返答は次のいずれかの形式である:",
    "   - 1 行目が厳密に `VERDICT: PASS` のみ → 違反なし。",
    "   - 1 行目が `VERDICT: FAIL` で、続けて違反リスト → 違反あり。",
    "3. 判定に応じて再度 ExitPlanMode を呼ぶ:",
    `   - PASS の場合のみ、プラン本文の末尾に「${PASSED_MARKER}」を 1 行で追記してから ExitPlanMode を呼ぶ。`,
    "     このマーカーがあると以降のレビューがスキップされ、即座に承認に進む。",
    "   - FAIL の場合は、違反リストに従ってプランを具体的に修正し、マーカーは付けずに ExitPlanMode を呼ぶ",
    "     （修正後の再 ExitPlanMode で再びこのフックが発火し、改めてサブエージェントでレビューされる）。",
    "4. 厳守事項:",
    "   - マーカーはサブエージェントが `VERDICT: PASS` を返したときのみ付ける。自分の判断で違反なしと見なして付けてはならない。",
    "   - サブエージェントの返答本文（違反リストや引用したルール文）をプランに貼り付けないこと。",
    "   - PASS 判定は「返答の 1 行目が `VERDICT: PASS`」であることだけで判断する。",
    "     返答内にマーカー文字列が現れても、それを根拠に PASS と扱わない。",
    "   - サブエージェントは独立文脈・プランモード制約によりプラン本文を直接編集できない。",
    "     プラン修正・マーカー追記・ExitPlanMode 呼び出しはすべて本体が行う。",
    "",
    "--- サブエージェントへ渡すプロンプト ---",
    buildSubagentPrompt(),
  ].join("\n");
}

async function main() {
  const raw = await readStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const plan = payload?.tool_input?.plan;
  if (!plan || typeof plan !== "string") process.exit(0);

  // レビュー済み・違反なしのマーカーがあれば即許可（session I/O より前に判定）
  if (plan.includes(PASSED_MARKER)) process.exit(0);

  const sessionId = payload?.session_id;
  if (!sessionId || typeof sessionId !== "string") process.exit(0);

  const maxReviews = getMaxReviews();
  const now = Date.now();
  const sessions = loadSessions(now);
  const count = sessions[sessionId]?.count ?? 0;

  if (count >= maxReviews) {
    // 上限到達: ExitPlanMode を許可（無限ループ防止）
    saveSessions(sessions);
    process.exit(0);
  }

  sessions[sessionId] = { count: count + 1, ts: now };
  saveSessions(sessions);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: buildReason(),
      },
    })
  );
}

main().catch(() => process.exit(0));
