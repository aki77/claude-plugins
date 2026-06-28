#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPT_LINES = 20;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function formatStamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
}

// transcript の先頭 20 行だけを読み、最初に見つかった plan_mode attachment の
// planFilePath からプランディレクトリを解決する。見つからなければ null。
async function resolvePlansDir(transcriptPath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let count = 0;
  let plansDir = null;
  try {
    for await (const line of rl) {
      count += 1;
      if (line.includes('"planFilePath"')) {
        try {
          const entry = JSON.parse(line);
          const planFilePath = entry?.attachment?.type === "plan_mode"
            ? entry.attachment.planFilePath
            : undefined;
          if (planFilePath) {
            plansDir = path.dirname(planFilePath);
            break;
          }
        } catch {
          // 壊れた行はスキップ
        }
      }
      if (count >= MAX_TRANSCRIPT_LINES) break;
    }
  } finally {
    rl.close();
  }
  return plansDir;
}

function archiveOldPlans(plansDir) {
  let entries;
  try {
    entries = fs.readdirSync(plansDir, { withFileTypes: true });
  } catch {
    return; // plansDir が存在しない等
  }

  const now = Date.now();
  const targets = [];
  for (const dirent of entries) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
    const src = path.join(plansDir, dirent.name);
    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs >= THIRTY_DAYS_MS) {
      targets.push({ name: dirent.name, src, mtime: stat.mtime });
    }
  }

  if (targets.length === 0) return;

  const archivedDir = path.join(plansDir, "archived");
  fs.mkdirSync(archivedDir, { recursive: true });

  for (const { name, src, mtime } of targets) {
    const stamp = formatStamp(mtime);
    let dest = path.join(archivedDir, `${stamp}_${name}`);
    // 同名衝突時は連番サフィックスを付ける（分単位 stamp なので稀）
    if (fs.existsSync(dest)) {
      const ext = path.extname(name);
      const base = name.slice(0, name.length - ext.length);
      let i = 2;
      while (fs.existsSync(dest)) {
        dest = path.join(archivedDir, `${stamp}_${base}_${i}${ext}`);
        i += 1;
      }
    }
    try {
      fs.renameSync(src, dest);
    } catch {
      // 移動失敗は無視して次へ
    }
  }
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // 再帰ループ防止
  if (payload?.stop_hook_active === true) process.exit(0);

  const transcriptPath = payload?.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  const plansDir = await resolvePlansDir(transcriptPath);
  if (!plansDir) process.exit(0);

  archiveOldPlans(plansDir);
  process.exit(0);
}

main().catch(() => process.exit(0));
