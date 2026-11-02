import readline from "node:readline/promises";
import type { FileOp } from "../proposal.js";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const B = "\x1b[1m";
const X = "\x1b[0m";

export async function confirmTerminal(ops: FileOp[]): Promise<boolean> {
  if (ops.length === 0) return true;
  console.log(`\n${B}── 待确认变更 (${ops.length} 个文件) ──${X}`);
  for (let i = 0; i < ops.length; i++) {
    const f = ops[i];
    const tag =
      f.risk === "high"
        ? `${R}[${f.risk.toUpperCase()}]${X}`
        : f.risk === "medium"
        ? `${Y}[${f.risk}]${X}`
        : `${G}[${f.risk}]${X}`;
    console.log(`${i + 1}. ${tag} ${f.path}`);
    console.log(`   ← ${f.reason}  (${diffSummary(f)})`);
    if (f.resolved.note) console.log(`   ⚠ ${f.resolved.note}`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const ans = (await rl.question("\n应用？ [Y]es / [n]o / [e]看diff / [1-9]看单个: ")).trim().toLowerCase();
      if (!ans || ans === "y" || ans === "yes") return true;
      if (ans === "n" || ans === "no") return false;
      if (ans === "e") {
        for (const f of ops) console.log(`\n${B}${f.path}${X}\n${makeDiff(f)}`);
        continue;
      }
      const i = parseInt(ans, 10) - 1;
      if (i >= 0 && i < ops.length) {
        console.log(`\n${B}${ops[i].path}${X}\n${makeDiff(ops[i])}`);
        continue;
      }
    }
  } finally {
    rl.close();
  }
}

export async function pickCandidate(cands: string[], asked: string): Promise<string | null> {
  console.log(`\n${B}未找到 "${asked}"，请选择正确的文件：${X}`);
  cands.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  console.log("  0. 都不是，我手动输入");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question("> ")).trim();
    const n = parseInt(ans, 10);
    if (Number.isInteger(n) && n >= 1 && n <= cands.length) return cands[n - 1];
    if (ans === "0") {
      const manual = (await rl.question("请输入路径: ")).trim();
      return manual || null;
    }
    return null;
  } finally {
    rl.close();
  }
}

export function autoAllowed(): boolean {
  return process.argv.includes("--yes") || process.env.AGENT_AUTO_APPROVE === "1";
}

function makeDiff(op: FileOp): string {
  const lines: string[] = [`--- a/${op.path}`, `+++ b/${op.path}`];
  const afterLines = op.after.split("\n");
  const beforeSet = new Set(op.before.split("\n"));
  for (const l of afterLines) {
    lines.push(beforeSet.has(l) ? ` ${l}` : `+${l}`);
  }
  return lines.join("\n");
}

function diffSummary(op: FileOp): string {
  const a = op.before.split("\n").length;
  const b = op.after.split("\n").length;
  return `+${Math.max(0, b - a)}/-${Math.max(0, a - b)}`;
}