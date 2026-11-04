import fs from "node:fs/promises";
import path from "node:path";
import { IGNORE } from "../config.js";
import { resolvePath, isSensitivePath, isUnderAny, type ResolveResult } from "../guard.js";
import { classify, decide, type FileOp } from "../policy.js";
import { autoAllowed } from "../ui/confirm.js";
import type { ToolCtx } from "./ctx.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 2000;

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

function hint(r: Pick<ResolveResult, "note" | "candidates">, op: string): string {
  const head = `无法${op}：${r.note}`;
  if (r.candidates.length === 1) {
    return `${head}\n你是不是想操作这个文件？→ ${r.candidates[0]}（请用该相对路径重试）`;
  }
  if (r.candidates.length > 1) {
    return `${head}\n候选：\n${r.candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n请用上述准确路径重试，或用 list_files 进一步确认。`;
  }
  return `${head}\n请先用 list_files / search_code 确认真实路径后再操作。`;
}

/** 读类工具可以使用的解析结果 */
export const isReadable = (r: ResolveResult) => r.status === "exact" || r.status === "converged" || r.status === "external";

/**
 * 读类工具（read_file / list_files / read_document / view_image）的统一解析：
 * 项目内照常；项目外已存在的路径 → 首次需要用户授权，授权后整个所在目录在本会话内可读（只读）。
 * 写操作不走这里，仍然只能在项目内。
 */
export async function resolveForRead(ctx: ToolCtx, p: unknown): Promise<ResolveResult> {
  const r = resolvePath(ctx.root, p, { external: true });
  if (r.status !== "external") return r;
  if (isUnderAny(r.abs, ctx.extraRoots)) return r;

  let dir = r.abs;
  try { if (!(await fs.stat(r.abs)).isDirectory()) dir = path.dirname(r.abs); } catch { /* 按原路径处理 */ }

  const ok = autoAllowed() ? true : ctx.askExternal ? await ctx.askExternal(dir) : false;
  if (!ok) {
    return {
      status: "outside", abs: r.abs, candidates: [],
      note: `${r.abs} 在工作目录外，需要用户授权才能读取${ctx.askExternal ? "（用户未同意）" : "（当前是非交互环境，可用 --yes 启动，或 /cd 切换到该目录）"}。不要重复尝试；请在回复里说明这一点。`,
    };
  }
  ctx.extraRoots.add(dir);
  console.error(`[audit] EXTERNAL READ GRANTED ${dir}`);
  return r;
}

/**
 * 写操作的统一闸门：风险评估 → 必要时请用户确认。
 * 返回 null 表示放行；返回字符串则是"拒绝原因"，作为观察交还给模型。
 */
async function gate(ctx: ToolCtx, op: FileOp): Promise<string | null> {
  const d = decide(op, ctx.approved);
  if (d.verdict === "allow") return null;
  if (d.verdict === "deny") return `[已拒绝] ${d.why}`;

  if (autoAllowed()) {
    console.error(`[audit] AUTO-APPROVED ${op.action} ${op.path}（${d.why}）`);
    return null;
  }
  if (!ctx.approve) {
    return `[需要用户确认，但当前是非交互环境，未执行] ${op.action} ${op.path}（${d.why}）。请换一种不需要该操作的方案，或在总结里说明，让用户手动处理（也可用 --yes 启动）。`;
  }
  const ans = await ctx.approve([{ ...op, reason: d.why }]);
  if (ans === "no") {
    return `[用户拒绝] 用户不同意对 ${op.path} 执行 ${op.action}。不要重复尝试同一操作；换一种方案，或在总结中说明。`;
  }
  if (ans === "always") ctx.approved.add(op.resolved.abs);
  return null;
}

/** start/end 为 1-based 闭区间 */
export async function readFile(ctx: ToolCtx, p: unknown, start?: number, end?: number): Promise<string> {
  const r = await resolveForRead(ctx, p);
  if (!isReadable(r)) return hint(r, "读取");

  const st = await fs.stat(r.abs);
  if (st.isDirectory()) return `${String(p)} 是目录，请用 list_files`;
  const ranged = start !== undefined || end !== undefined;
  if (st.size > MAX_READ_BYTES && !ranged) {
    return `文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB），请用 start_line/end_line 分段读取，或用 search_code 定位`;
  }
  const buf = await fs.readFile(r.abs);
  if (looksBinary(buf)) return `${String(p)} 是二进制文件，无法按文本读取`;

  const lines = buf.toString("utf-8").split(/\r?\n/);
  const s = Math.max(start ?? 1, 1);
  let e = Math.min(end ?? lines.length, lines.length);
  let note = "";
  if (!ranged && e - s + 1 > MAX_READ_LINES) {
    e = s + MAX_READ_LINES - 1;
    note = `\n…（共 ${lines.length} 行，仅显示前 ${MAX_READ_LINES} 行，用 start_line 继续读取）`;
  }
  if (s > lines.length) return `文件只有 ${lines.length} 行`;
  return lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n") + note;
}

export async function writeFile(ctx: ToolCtx, p: unknown, content: string): Promise<string> {
  const r = resolvePath(ctx.root, p, { intent: "write", create: true });
  if (r.status !== "exact" && r.status !== "converged" && r.status !== "new") return hint(r, "写入");

  const exists = r.status !== "new";
  const before = exists ? await fs.readFile(r.abs, "utf-8").catch(() => "") : "";
  const op = classify(
    { path: String(p), action: exists ? "edit" : "create", before, after: content, reason: "write_file", resolved: r },
    ctx.task,
  );
  const refused = await gate(ctx, op);
  if (refused) return refused;

  await ctx.workspace.record(r.abs);
  await fs.mkdir(path.dirname(r.abs), { recursive: true });
  await fs.writeFile(r.abs, content, "utf-8");
  console.error(`[audit] WRITE ${r.abs}`);
  return `已写入 ${String(p)}（${content.length} 字符）`;
}

export async function editFile(ctx: ToolCtx, p: unknown, oldText: string, newText: string): Promise<string> {
  if (!oldText) return "old_text 不能为空；新建文件请用 write_file";
  const r = resolvePath(ctx.root, p, { intent: "write" });
  if (r.status !== "exact" && r.status !== "converged") return hint(r, "编辑");

  const src = await fs.readFile(r.abs, "utf-8");

  // Windows 上文件常是 CRLF，而模型输出的是 LF，直接比较永远匹配不上
  const crlf = src.includes("\r\n");
  const norm = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n"));
  const o = norm(oldText);
  const n = norm(newText);

  const count = src.split(o).length - 1;
  if (count === 0) {
    const firstLine = oldText.split(/\r?\n/).find((l) => l.trim());
    const at = firstLine ? src.split(/\r?\n/).findIndex((l) => l.includes(firstLine.trim())) : -1;
    return at >= 0
      ? `未找到完全匹配的文本。old_text 的首行大致出现在第 ${at + 1} 行，请 read_file 核对缩进/空白后重试`
      : `未找到匹配文本，请先 read_file 获取最新内容`;
  }
  if (count > 1) return `匹配到 ${count} 处，old_text 不够唯一，请扩大上下文`;

  // 必须用函数替换：字符串形式的 new_text 里若含 $& $1 $$ 会被 replace 当作特殊模式解释
  const next = src.replace(o, () => n);
  const op = classify({ path: String(p), action: "edit", before: src, after: next, reason: "edit_file", resolved: r }, ctx.task);
  const refused = await gate(ctx, op);
  if (refused) return refused;

  await ctx.workspace.record(r.abs);
  await fs.writeFile(r.abs, next, "utf-8");
  console.error(`[audit] EDIT ${r.abs}`);
  return `已替换 ${String(p)}`;
}

/** 删除一律需要确认；journal 里保留了原内容，所以可以 /undo */
export async function deleteFile(ctx: ToolCtx, p: unknown): Promise<string> {
  const r = resolvePath(ctx.root, p, { intent: "write" });
  if (r.status !== "exact" && r.status !== "converged") return hint(r, "删除");
  const st = await fs.stat(r.abs);
  if (st.isDirectory()) return `${String(p)} 是目录；出于安全考虑只允许删除单个文件`;

  const before = st.size <= MAX_READ_BYTES ? await fs.readFile(r.abs, "utf-8").catch(() => "") : "";
  const op = classify({ path: String(p), action: "delete", before, after: "", reason: "delete_file", resolved: r }, ctx.task);
  const refused = await gate(ctx, op);
  if (refused) return refused;

  await ctx.workspace.record(r.abs);
  await fs.unlink(r.abs);
  console.error(`[audit] DELETE ${r.abs}`);
  return `已删除 ${String(p)}`;
}

export async function listFiles(ctx: ToolCtx, p: unknown, depth = 3): Promise<string> {
  const r = await resolveForRead(ctx, p ?? ".");
  if (!isReadable(r)) return hint(r, "列出");
  const parts: string[] = [];
  const LIMIT = 500;
  let truncated = false;

  async function walk(dir: string, d: number, prefix = "") {
    if (d < 0 || truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e: any) {
      parts.push(`${prefix}(无法读取：${e.code ?? e.message})`);
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORE.has(e.name)) continue;
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      if (isSensitivePath(path.relative(ctx.root, path.join(dir, e.name)))) continue;
      if (parts.length >= LIMIT) { truncated = true; return; }
      parts.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory()) await walk(path.join(dir, e.name), d - 1, `${prefix}  `);
    }
  }
  await walk(r.abs, depth);
  if (truncated) parts.push(`…（超过 ${LIMIT} 项已截断，请指定子目录或减小 depth）`);
  return parts.join("\n") || `(空目录：${r.status === "external" ? r.abs : path.relative(ctx.root, r.abs) || "."})`;
}
