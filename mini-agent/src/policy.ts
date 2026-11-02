import path from "node:path";
import type { ResolveResult } from "./guard.js";

/**
 * 写操作的风险评估与放行策略（由 proposal.ts 演进而来）。
 *
 * 旧设计：模型先吐一份"整文件 newContent"的提案 → 分组 → 一次性确认 → 应用。
 *   问题：整文件输出在大文件上会被截断并损坏文件；模型看不到执行结果（没有 observation）；
 *         无法"边做边验证"。
 * 新设计：保留同一套评分与确认 UI，但作用在 ReAct 循环里的每一次写工具调用上
 *   （对应 Cursor 的逐操作审批）：低风险自动放行，高风险/破坏性操作才打断用户。
 */

export type Action = "edit" | "create" | "delete";
export type Risk = "low" | "medium" | "high";

export type FileOp = {
  path: string;
  action: Action;
  before: string;
  after: string;
  reason: string;
  risk: Risk;
  score: number;
  resolved: ResolveResult;
};

const CONFIG = /\.(?:json|toml|ya?ml|xml|gradle|mk|makefile|gitignore|npmignore)$/i;
const DOTFILES = /^(?:Dockerfile|Makefile|Cargo\.toml|pyproject\.toml|tsconfig\.json|package\.json|go\.mod|\.env\.example)$/i;
const SRC = /^(?:src|lib|app|pkg|internal|cmd|tests?|spec)\b/i;

const isConfigLike = (p: string) => CONFIG.test(p) || DOTFILES.test(path.basename(p));

export function classify(op: Omit<FileOp, "risk" | "score">, task = ""): FileOp {
  const { resolved } = op;
  let score = 0;

  if (resolved.status === "exact") score += 3;
  // "new" = 路径已校验合法、父目录存在、确实是在新建。它和 exact 一样值得信任；
  // 否则下面 create 的 -3 会让任何普通新文件都被评为 high 并弹窗确认
  if (resolved.status === "new") score += 3;
  if (resolved.status === "converged") score += 1;
  if (mentioned(task, op.path)) score += 2;
  if (SRC.test(op.path.replace(/\\/g, "/"))) score += 1;
  if (op.action === "create") score -= 3;
  if (op.action === "delete") score -= 4;
  if (isConfigLike(op.path)) score -= 3;
  if (resolved.status === "candidate") score -= 1;
  if (resolved.status === "outside" || resolved.status === "escape") score -= 6;
  if (resolved.status === "notfound" || resolved.status === "blocked") score -= 8;

  const delta = Math.abs(op.after.split("\n").length - op.before.split("\n").length);
  if (delta <= 200) score += 1;

  const risk: Risk = score >= 3 ? "low" : score >= 0 ? "medium" : "high";
  return { ...op, risk, score };
}

export type Verdict = "allow" | "ask" | "deny";
export type Decision = { verdict: Verdict; why: string };

/**
 * deny  路径本身不合法（越界/受保护/不存在）——直接把原因还给模型让它改路径，不打扰用户
 * ask   破坏性或高风险——需要人确认
 * allow 其余自动放行（用户已通过 /fix 等命令授权 Agent 修改代码）
 */
export function decide(op: FileOp, approved?: ReadonlySet<string>): Decision {
  const s = op.resolved.status;
  if (s === "outside" || s === "escape" || s === "blocked" || s === "notfound" || s === "candidate") {
    return { verdict: "deny", why: op.resolved.note || `路径不可用（${s}）` };
  }
  if (op.action === "delete") return { verdict: "ask", why: "删除文件" };
  if (approved?.has(op.resolved.abs)) return { verdict: "allow", why: "本会话已授权" };
  if (op.action === "create" && isConfigLike(op.path)) return { verdict: "ask", why: "新建配置类文件" };
  if (op.risk === "high") return { verdict: "ask", why: `风险评分过低（score=${op.score}）` };
  return { verdict: "allow", why: "" };
}

export function diffSummary(op: Pick<FileOp, "before" | "after">): string {
  const a = op.before === "" ? 0 : op.before.split("\n").length;
  const b = op.after === "" ? 0 : op.after.split("\n").length;
  return `+${Math.max(0, b - a)}/-${Math.max(0, a - b)} (${b} lines)`;
}

function mentioned(bag: string, p: string): boolean {
  if (!bag) return false;
  const b = bag.toLowerCase();
  return b.includes(p.toLowerCase()) || b.includes(path.basename(p).toLowerCase());
}
