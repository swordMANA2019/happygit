import fs from "node:fs";
import path from "node:path";

export type ResolveStatus =

  | "exact"      // 存在且落在 cwd 内，直接操作
  | "converged"  // 绝对路径被收敛到 cwd 内
  | "candidate"  // 不存在，但搜到候选
  | "outside"    // 落在 cwd 外
  | "escape"     // realpath 后跳出 cwd（symlink 逃逸）
  | "notfound"   // 不存在且无候选
  | "blocked";   // .git / node_modules 等受保护路径

export type ResolveResult = {
  status: ResolveStatus;
  abs: string;
  note: string;
  candidates: string[];
};

const BLOCKED = /^(?:\.git|\.svn|\.hg)(?:\/|$)|\/(?:\.git|\.svn|\.hg)(?:\/|$)|^node_modules(?:\/|$)/i;
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function same(a: string, b: string): boolean {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function insideRoot(p: string, root: string): boolean {
  const r = root.endsWith(path.sep) ? root : root + path.sep;
  return same(p, root) || (CASE_INSENSITIVE ? p.toLowerCase().startsWith(r.toLowerCase()) : p.startsWith(r));
}

/**
 * 所有 read/write/edit/list 的路径都必须走这里。
 * root 必须是已归一化的绝对路径（由 Session 保证）。
 */
export function resolvePath(
  root: string,
  p: unknown,
  opts: { maxCandidates?: number } = {}
): ResolveResult {
  const maxCand = opts.maxCandidates ?? 8;

  if (!p || typeof p !== "string") return reject("路径为空");
  const raw = p.trim();
  if (!raw) return reject("路径为空");
  if (raw.includes("\0")) return reject("路径含空字节");

  // 1) 剥掉绝对前缀，退化为相对段（防手滑）
  const wasAbsolute = /^[\\/]|[A-Za-z]:[\\/]/.test(raw);
  let cleaned = raw.replace(/^[\\/]+/, "").replace(/^[A-Za-z]:[\\/]?/, "");
  if (cleaned.startsWith("\\\\")) cleaned = cleaned.slice(2);

  // 2) 归一化 + 前缀检查
  const normRoot = path.normalize(root);
  const abs = path.normalize(path.join(normRoot, cleaned));
  const inside = abs === normRoot || abs.startsWith(normRoot + path.sep);

  // 3) 黑名单（不管存不存在都拦）
  const rel = path.relative(normRoot, abs).replace(/\\/g, "/");
  if (BLOCKED.test(rel)) return blocked(rel);

  // 4) 存在性 / symlink 判定
  const realRoot = safeRealpath(normRoot);
  const realAbs = nearestRealpath(abs);

  if (realAbs && !insideRoot(realAbs, realRoot)) {
    return escape(raw, abs, realAbs);
  }
  if (!inside) {
    return outside(raw, abs);
  }
  if (fs.existsSync(abs)) {
    return exact(abs);
  }

  // 5) 不存在 → 按文件名搜索
  const name = path.basename(raw);
  const hits = findFilesByNameSync(normRoot, name, maxCand + 1);
  if (hits.length === 1) {
    return candidate(path.join(normRoot, hits[0]), hits, `未找到 "${raw}"，命中单个候选：${hits[0]}`);
  }
  if (hits.length > 1) {
    return candidate(abs, hits.slice(0, maxCand), `未找到 "${raw}"，候选：${hits.slice(0, maxCand).join("、")}`);
  }
  return notfound(raw, rel, wasAbsolute);
}

function exact(abs: string): ResolveResult {
  return { status: "exact", abs, note: "", candidates: [] };
}
function converged(input: string, abs: string): ResolveResult {
  return { status: "converged", abs, note: `绝对路径已收敛到工作目录内：${input} → ${abs}`, candidates: [] };
}
function outside(input: string, abs: string): ResolveResult {
  return { status: "outside", abs, note: `目标在工作目录外：${input} → ${abs}`, candidates: [] };
}
function escape(input: string, abs: string, real: string): ResolveResult {
  return { status: "escape", abs, note: `路径经解析后跳出工作目录（symlink?）：${input} → ${abs} → ${real}`, candidates: [] };
}
function candidate(fallback: string, cands: string[], note: string): ResolveResult {
  return { status: "candidate", abs: fallback, note, candidates: cands };
}
function notfound(input: string, rel: string, wasAbs: boolean): ResolveResult {
  return {
    status: "notfound",
    abs: "",
    note: wasAbs
      ? `文件不存在：${input}（已收敛为相对路径 ${rel}，仍未找到）`
      : `文件不存在：${rel}，请先用 list_files 确认真实路径`,
    candidates: [],
  };
}
function blocked(rel: string): ResolveResult {
  return { status: "blocked", abs: "", note: `禁止操作受保护路径：${rel}`, candidates: [] };
}
function reject(msg: string): ResolveResult {
  return { status: "notfound", abs: "", note: msg, candidates: [] };
}

function safeRealpath(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

function nearestRealpath(p: string): string | null {
  let cur = p;
  while (true) {
    try { return fs.realpathSync.native(cur); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

/** 同步版文件名查找（guard 必须是纯同步、零依赖） */
function findFilesByNameSync(root: string, name: string, limit: number): string[] {
  const out: string[] = [];
  const needle = name.toLowerCase();
  const skip = new Set(["node_modules", "dist", "build", ".git", "__pycache__", "venv", ".venv"]);
  const walk = (dir: string, depth: number) => {
    if (depth < 0 || out.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth - 1); continue; }
      const lower = e.name.toLowerCase();
      if (lower === needle || lower.includes(needle)) {
        out.push(path.relative(root, p));
        if (out.length >= limit) return;
      }
    }
  };
  walk(root, 6);
  return out;
}

/** cwd 收敛（供 run_command 用） */
export function resolveCwd(root: string, cwd?: string): string {
  if (!cwd) return path.normalize(root);
  const r = resolvePath(root, cwd);
  if (r.status === "exact" || r.status === "converged") return r.abs;
  throw new Error(`run_command cwd 非法：${r.note}`);
}

// ---- 会话级 allowlist（提案确认后放行） ----

const ALLOWED = new Map<string, Set<string>>();

export function setAllowed(sessionId: string, paths: Iterable<string>): void {
  ALLOWED.set(sessionId, new Set(paths));
}

export function clearAllowed(sessionId: string): void {
  ALLOWED.delete(sessionId);
}

export function checkAllowed(sessionId: string | undefined, abs: string): string | null {
  if (!sessionId) return null;
  const s = ALLOWED.get(sessionId);
  if (!s) return null;
  return s.has(abs) ? null : `文件未在已确认的提案中：${abs}（需重新确认）`;
}