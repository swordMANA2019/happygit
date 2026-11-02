import type { FileOp } from "../policy.js";
import { diffSummary } from "../policy.js";
import { unifiedDiff } from "../workspace.js";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const B = "\x1b[1m";
const X = "\x1b[0m";

/** 提问函数由 Session 注入——全程只用一个 readline，避免两个接口抢 stdin */
export type AskFn = (question: string) => Promise<string>;
export type Approval = "yes" | "no" | "always";

export async function confirmOps(ask: AskFn, ops: FileOp[]): Promise<Approval> {
  if (ops.length === 0) return "yes";
  console.log(`\n${B}── 待确认变更 (${ops.length} 个文件) ──${X}`);
  ops.forEach((f, i) => {
    const tag =
      f.risk === "high" ? `${R}[HIGH]${X}` : f.risk === "medium" ? `${Y}[medium]${X}` : `${G}[low]${X}`;
    console.log(`${i + 1}. ${tag} ${f.action} ${f.path}`);
    console.log(`   ← ${f.reason || "(无说明)"}  (${diffSummary(f)})`);
    if (f.resolved.note) console.log(`   ⚠ ${f.resolved.note}`);
  });

  while (true) {
    const ans = (await ask("\n应用？ [Y]es / [n]o / [a]lways(本会话同一文件不再问) / [d]iff: ")).trim().toLowerCase();
    // 空串也可能来自"输入被中断"，此时必须按拒绝处理，而不是默认同意
    if (ans === "y" || ans === "yes") return "yes";
    if (ans === "n" || ans === "no" || ans === "") return "no";
    if (ans === "a" || ans === "always") return "always";
    if (ans === "d" || ans === "diff") {
      for (const f of ops) console.log(`\n${B}${f.path}${X}\n${makeDiff(f)}`);
    }
  }
}

function makeDiff(op: FileOp): string {
  return unifiedDiff(op.path, op.action === "create" ? null : op.before, op.action === "delete" ? null : op.after) || "(无差异)";
}

export function autoAllowed(): boolean {
  return process.argv.includes("--yes") || process.env.AGENT_AUTO_APPROVE === "1";
}
