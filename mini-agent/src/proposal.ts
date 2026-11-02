import path from "node:path";
import crypto from "node:crypto";
import { resolvePath, type ResolveResult } from "./guard.js";

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

export type Proposal = {
  id: string;
  files: FileOp[];
  summary: string;
};

const CONFIG = /\.(?:json|toml|ya?ml|xml|gradle|mk|makefile|gitignore|npmignore)$/i;
const DOTFILES = /^(?:Dockerfile|Makefile|Cargo\.toml|pyproject\.toml|tsconfig\.json|package\.json|go\.mod|\.env\.example)$/i;
const SRC = /^(?:src|lib|app|pkg|internal|cmd|tests?|spec)\b/i;

export function classify(
  root: string,
  task: string,
  ctx: string,
  op: Omit<FileOp, "risk" | "score" | "resolved">
): FileOp {
  const resolved = resolvePath(root, op.path);
  let score = 0;

  if (resolved.status === "exact") score += 3;
  if (resolved.status === "converged") score += 1;
  if (mentioned(task + "\n" + ctx, op.path)) score += 2;
  if (SRC.test(op.path)) score += 1;
  if (op.action === "create") score -= 3;
  if (op.action === "delete") score -= 4;
  if (CONFIG.test(op.path) || DOTFILES.test(path.basename(op.path))) score -= 3;
  if (resolved.status === "candidate") score -= 1;
  if (resolved.status === "outside" || resolved.status === "escape") score -= 6;
  if (resolved.status === "notfound" || resolved.status === "blocked") score -= 8;

  const delta = Math.abs(op.after.split("\n").length - op.before.split("\n").length);
  if (delta <= 200) score += 1;

  const risk: Risk = score >= 3 ? "low" : score >= 0 ? "medium" : "high";
  return { ...op, risk, score, resolved };
}

export function needsConfirm(op: FileOp): boolean {
  if (op.resolved.status === "exact") return false;
  // 单候选且同名（用户说 test.py，命中 tests/test.py）→ 可自动，除非显式要求确认
  if (
    op.resolved.status === "candidate" &&
    op.resolved.candidates.length === 1 &&
    path.basename(op.path).toLowerCase() === path.basename(op.resolved.candidates[0]).toLowerCase()
  ) {
    return process.env.AGENT_AUTO_CONFIRM_EXISTING !== "1";
  }
  return true;
}

export function groupOps(ops: FileOp[]): { auto: FileOp[]; ask: FileOp[] } {
  return ops.reduce(
    (a, f) => {
      (needsConfirm(f) ? a.ask : a.auto).push(f);
      return a;
    },
    { auto: [] as FileOp[], ask: [] as FileOp[] }
  );
}

export function proposalId(): string {
  return crypto.randomBytes(6).toString("hex");
}

export function diffSummary(op: FileOp): string {
  const a = op.before.split("\n").length;
  const b = op.after.split("\n").length;
  return `+${Math.max(0, b - a)}/-${Math.max(0, a - b)} (${b} lines)`;
}

function mentioned(bag: string, p: string): boolean {
  const b = bag.toLowerCase();
  return b.includes(p.toLowerCase()) || b.includes(path.basename(p).toLowerCase());
}