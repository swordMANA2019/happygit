import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execCommand } from "./tools/shell.js";

/**
 * Workspace = Agent 对项目文件改动的"事务日志"（对应 Cursor 的 checkpoint / 一键撤销）。
 *
 * 为什么不用 git 做检查点（旧实现 gitCheckpoint / gitRollback）：
 *   1. 机器上可能没装 git、目录可能不是仓库、可能没配 user.name/email
 *      —— 旧代码在这些环境下直接抛异常，整个修复任务崩溃；
 *   2. `git add -A && git commit` 会把用户未提交的工作、.agent/、甚至密钥提交进历史；
 *   3. 回滚用的 `git reset --hard` + `git clean -fd` 会误删用户自己的未提交改动和未跟踪文件；
 *   4. "checkpoint" 提交永远留在用户分支上。
 *
 * 做法：Agent 的每一次写操作之前，先把文件原始内容记进 journal；
 * 回滚 = 按 journal 精确还原"Agent 动过的文件"，一个字节都不碰别的。
 * git 只作为可选的、只读的信息来源（见 gitInfo）。
 */

type Original = Buffer | null; // null = 文件原本不存在

export type FileChange = {
  rel: string;
  abs: string;
  kind: "added" | "modified" | "deleted";
  /** 新建文件 / 二进制文件为 null */
  before: string | null;
  /** 删除的文件 / 二进制文件为 null */
  after: string | null;
  binary: boolean;
};

export class Workspace {
  private journal = new Map<string, Original>();

  constructor(readonly root: string) {}

  /** 写操作前调用：首次触碰某文件时记录原始内容 */
  async record(abs: string): Promise<void> {
    if (this.journal.has(abs)) return;
    try {
      this.journal.set(abs, await fs.readFile(abs));
    } catch (e: any) {
      if (e?.code === "ENOENT") this.journal.set(abs, null);
      else throw e; // 读不了原文件就不能保证可回滚——宁可拒绝这次写入
    }
  }

  private rel(abs: string) {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  /** 真正发生了内容变化的文件（写入相同内容不算） */
  async changedFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const [abs, orig] of this.journal) {
      const cur = await fs.readFile(abs).catch(() => null);
      const same = (cur === null && orig === null) || (cur && orig && cur.equals(orig));
      if (!same) out.push(this.rel(abs));
    }
    return out.sort();
  }

  async hasChanges(): Promise<boolean> {
    return (await this.changedFiles()).length > 0;
  }

  /** 当前改动的指纹：用于识别"多轮重试做了同样的事" */
  async fingerprint(): Promise<string> {
    const h = crypto.createHash("sha1");
    for (const rel of await this.changedFiles()) {
      h.update(rel);
      h.update(await fs.readFile(path.join(this.root, rel)).catch(() => Buffer.alloc(0)));
    }
    return h.digest("hex");
  }

  /** 还原所有被 Agent 改动的文件；返回被还原的文件列表 */
  async rollback(): Promise<string[]> {
    const restored: string[] = [];
    for (const [abs, orig] of this.journal) {
      try {
        if (orig === null) {
          await fs.rm(abs, { force: true });
        } else {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, orig);
        }
        restored.push(this.rel(abs));
      } catch {
        /* 单个文件还原失败不应阻断其余文件 */
      }
    }
    this.journal.clear();
    return restored.sort();
  }

  /** 结构化的改动列表（给 /diff 的高亮视图用）：每个文件的前后内容；二进制只标记不带内容 */
  async changes(): Promise<FileChange[]> {
    const out: FileChange[] = [];
    const isBin = (b: Buffer | null) => !!b && b.subarray(0, 8000).includes(0);
    for (const [abs, orig] of this.journal) {
      const cur = await fs.readFile(abs).catch(() => null);
      if (cur === null && orig === null) continue;
      if (cur && orig && cur.equals(orig)) continue;
      const binary = isBin(cur) || isBin(orig);
      out.push({
        rel: this.rel(abs),
        abs,
        kind: orig === null ? "added" : cur === null ? "deleted" : "modified",
        before: binary || orig === null ? null : orig.toString("utf8"),
        after: binary || cur === null ? null : cur.toString("utf8"),
        binary,
      });
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** 不依赖 git 的 unified diff（给 critic / 用户看） */
  async diff(maxChars = 60_000): Promise<string> {
    const parts: string[] = [];
    for (const [abs, orig] of this.journal) {
      const cur = await fs.readFile(abs).catch(() => null);
      if (cur === null && orig === null) continue;
      if (cur && orig && cur.equals(orig)) continue;
      const isBin = (b: Buffer | null) => !!b && b.subarray(0, 8000).includes(0);
      const rel = this.rel(abs);
      if (isBin(cur) || isBin(orig)) { parts.push(`Binary file ${rel} changed`); continue; }
      parts.push(unifiedDiff(rel, orig?.toString("utf8") ?? null, cur?.toString("utf8") ?? null));
    }
    const text = parts.join("\n");
    return text.length > maxChars ? text.slice(0, maxChars) + "\n...(diff truncated)" : text;
  }
}

/* ---- 简易 unified diff（LCS；超大文件退化为"首尾裁剪"） ---- */

export type Op = { t: " " | "-" | "+"; s: string };

export function diffOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const mid: Op[] = [];
  if (am.length * bm.length > 4_000_000) {
    am.forEach((s) => mid.push({ t: "-", s }));
    bm.forEach((s) => mid.push({ t: "+", s }));
  } else {
    const n = am.length, m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { mid.push({ t: " ", s: am[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ t: "-", s: am[i++] });
      else mid.push({ t: "+", s: bm[j++] });
    }
    while (i < n) mid.push({ t: "-", s: am[i++] });
    while (j < m) mid.push({ t: "+", s: bm[j++] });
  }
  return [
    ...a.slice(0, pre).map((s): Op => ({ t: " ", s })),
    ...mid,
    ...a.slice(a.length - suf).map((s): Op => ({ t: " ", s })),
  ];
}

export function unifiedDiff(rel: string, before: string | null, after: string | null, ctx = 3): string {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  const ops = diffOps(a, b);
  const header = [`--- ${before === null ? "/dev/null" : "a/" + rel}`, `+++ ${after === null ? "/dev/null" : "b/" + rel}`];

  const changed = ops.map((o, i) => (o.t === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  const keep = new Set<number>();
  for (const idx of changed) {
    for (let k = Math.max(idx - ctx, 0); k <= Math.min(idx + ctx, ops.length - 1); k++) keep.add(k);
  }
  const lines: string[] = [];
  let prev = -1;
  for (const k of [...keep].sort((x, y) => x - y)) {
    if (prev >= 0 && k !== prev + 1) lines.push("@@");
    lines.push(ops[k].t + ops[k].s);
    prev = k;
  }
  return [...header, ...lines].join("\n");
}

/* ---- git：可选的只读信息 ---- */

export type GitInfo =
  | { state: "unavailable"; detail: string }   // 没装 git / 无法执行
  | { state: "not_repo" }
  | { state: "repo"; branch: string; dirty: string[] };

/** 只读探测，任何失败都降级为 unavailable / not_repo，绝不抛异常 */
export async function gitInfo(root: string): Promise<GitInfo> {
  const inside = await execCommand("git rev-parse --is-inside-work-tree", { cwd: root, timeoutMs: 8000 });
  if (!inside.ok) {
    if (/not a git repository/i.test(inside.stderr)) return { state: "not_repo" };
    return { state: "unavailable", detail: inside.reason || inside.stderr.trim().slice(0, 120) };
  }
  const br = await execCommand("git rev-parse --abbrev-ref HEAD", { cwd: root, timeoutMs: 8000 });
  const st = await execCommand("git status --porcelain", { cwd: root, timeoutMs: 15_000 });
  const dirty = st.ok ? st.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  return { state: "repo", branch: br.ok ? br.stdout.trim() || "(无提交)" : "(未知)", dirty };
}

/**
 * Agent 通过 run_command 产生的副作用无法进 journal（例如脚本生成文件）。
 * 有 git 时用前后 status 对比做一次"尽力而为"的提醒；没有 git 就返回空。
 */
export async function untrackedSideEffects(before: GitInfo, after: GitInfo, journaled: string[]): Promise<string[]> {
  if (before.state !== "repo" || after.state !== "repo") return [];
  const b = new Set(before.dirty);
  const known = new Set(journaled);
  return after.dirty
    .filter((l) => !b.has(l))
    .map((l) => l.replace(/^\S+\s+/, "").replace(/^"|"$/g, ""))
    .filter((p) => !known.has(p) && !p.startsWith(".agent/"));
}
