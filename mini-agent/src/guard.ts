import fs from "node:fs";
import path from "node:path";

/**
 * 所有 read / write / edit / delete / list / run_command(cwd) 的路径都必须走这里。
 * 无任何模块级状态：root 由调用方（Session）传入，所以多个会话可以并存。
 */

export type ResolveStatus =
  | "exact"      // 已存在且在 root 内
  | "converged"  // 绝对路径被收敛到 root 内（如 /src/a.ts → <root>/src/a.ts）
  | "new"        // 尚不存在、在 root 内，且调用方声明了要新建
  | "candidate"  // 不存在，但按文件名搜到候选
  | "outside"    // 落在 root 外
  | "escape"     // realpath 后跳出 root（symlink 逃逸）
  | "notfound"   // 不存在且无候选
  | "blocked";   // .git / node_modules(写) / 凭据文件 等受保护路径

export type Intent = "read" | "write";

export type ResolveResult = {
  status: ResolveStatus;
  abs: string;
  note: string;
  candidates: string[];
};

export type ResolveOpts = {
  /** 默认 read。write 会额外拦截 node_modules / .agent */
  intent?: Intent;
  /** 仅 write 有意义：允许目标不存在（新建文件） */
  create?: boolean;
  maxCandidates?: number;
};

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** 任何情况下都不允许碰 */
const BLOCKED_ALWAYS = /(^|\/)(?:\.git|\.svn|\.hg)(?:\/|$)/i;
/** 只在写入时拦截（读 node_modules 里的库源码来排查问题是合理的） */
const BLOCKED_WRITE = /(^|\/)(?:node_modules|\.agent)(?:\/|$)/i;

/**
 * 凭据 / 私钥：读取它们等于把密钥发给了 LLM 服务商。
 * .env.example / .env.sample 是模板，放行。AGENT_ALLOW_SECRETS=1 可整体关闭。
 */
const SECRET_RE =
  /(^|\/)(?:\.env(?!\.(?:example|sample|template)$)(?:\..+)?|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx|keystore)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i;

export function isSensitivePath(rel: string): boolean {
  if (process.env.AGENT_ALLOW_SECRETS === "1") return false;
  return SECRET_RE.test(rel.replace(/\\/g, "/"));
}

const norm = (p: string) => (CASE_INSENSITIVE ? path.resolve(p).toLowerCase() : path.resolve(p));

export function isInside(p: string, root: string): boolean {
  const a = norm(p);
  const r = norm(root);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

export function resolvePath(root: string, p: unknown, opts: ResolveOpts = {}): ResolveResult {
  const intent = opts.intent ?? "read";
  const maxCand = opts.maxCandidates ?? 8;

  if (!p || typeof p !== "string") return reject("路径为空");
  const raw = p.trim();
  if (!raw) return reject("路径为空");
  if (raw.includes("\0")) return reject("路径含空字节");

  const normRoot = path.resolve(root);

  // 1) 绝对路径：本来就在 root 内就直接用（旧实现一律剥掉盘符/前导斜杠，
  //    于是模型给出的合法绝对路径 C:\proj\src\a.ts 会被拼成 <root>\proj\src\a.ts 然后"找不到"）。
  //    不在 root 内才收敛：剥掉前缀当作相对路径，永远不会真的去碰 root 外的位置。
  let abs: string;
  let converged = false;
  if (path.isAbsolute(raw)) {
    const direct = path.resolve(raw);
    if (isInside(direct, normRoot)) {
      abs = direct;
    } else {
      const cleaned = raw.replace(/^[A-Za-z]:/, "").replace(/^[\\/]+/, "");
      abs = path.resolve(normRoot, cleaned);
      converged = true;
    }
  } else {
    abs = path.resolve(normRoot, raw);
  }

  // 2) 越界（../../x）
  if (!isInside(abs, normRoot)) return outside(raw, abs);

  // 3) 黑名单 / 凭据：不管存不存在都拦
  const rel = path.relative(normRoot, abs).replace(/\\/g, "/");
  if (BLOCKED_ALWAYS.test(rel)) return blocked(`禁止操作受保护路径：${rel}`);
  if (intent === "write" && BLOCKED_WRITE.test(rel)) return blocked(`禁止写入受保护路径：${rel}`);
  if (isSensitivePath(rel)) {
    return blocked(`${rel} 疑似密钥/凭据文件，默认禁止访问（它的内容会被发送给 LLM 服务商）。确需访问请设置 AGENT_ALLOW_SECRETS=1`);
  }

  // 4) symlink 逃逸：用最近的已存在祖先做 realpath
  const realRoot = safeRealpath(normRoot);
  const realAbs = nearestRealpath(abs);
  if (realAbs && !isInside(realAbs, realRoot)) return escape(raw, abs, realAbs);

  // 5) 存在性
  if (fs.existsSync(abs)) return converged ? conv(raw, abs) : exact(abs);

  // 6) 不存在
  if (intent === "write" && opts.create) {
    // 父目录存在 → 这就是一次正常的"新建文件"；父目录也不存在则很可能是路径写错了，
    // 先按文件名找找看有没有真实文件，避免凭空建出一堆目录
    const parentExists = fs.existsSync(path.dirname(abs));
    if (parentExists) return { status: "new", abs, note: "", candidates: [] };
    const hits = findFilesByNameSync(normRoot, path.basename(abs), maxCand + 1);
    if (hits.length === 0) return { status: "new", abs, note: "", candidates: [] };
    return candidate(abs, hits.slice(0, maxCand), `目录 ${path.relative(normRoot, path.dirname(abs)) || "."} 不存在，但项目里有同名文件：${hits.slice(0, maxCand).join("、")}`);
  }

  const hits = findFilesByNameSync(normRoot, path.basename(raw), maxCand + 1);
  if (hits.length === 1) return candidate(path.join(normRoot, hits[0]), hits, `未找到 "${raw}"，命中单个候选：${hits[0]}`);
  if (hits.length > 1) return candidate(abs, hits.slice(0, maxCand), `未找到 "${raw}"，候选：${hits.slice(0, maxCand).join("、")}`);
  return notfound(raw, rel);
}

const exact = (abs: string): ResolveResult => ({ status: "exact", abs, note: "", candidates: [] });
const conv = (input: string, abs: string): ResolveResult => ({ status: "converged", abs, note: `绝对路径已收敛到工作目录内：${input} → ${abs}`, candidates: [] });
const outside = (input: string, abs: string): ResolveResult => ({ status: "outside", abs, note: `目标在工作目录外：${input} → ${abs}`, candidates: [] });
const escape = (input: string, abs: string, real: string): ResolveResult => ({ status: "escape", abs, note: `路径经解析后跳出工作目录（symlink?）：${input} → ${abs} → ${real}`, candidates: [] });
const candidate = (fallback: string, cands: string[], note: string): ResolveResult => ({ status: "candidate", abs: fallback, note, candidates: cands });
const notfound = (input: string, rel: string): ResolveResult => ({ status: "notfound", abs: "", note: `文件不存在：${rel || input}，请先用 list_files 确认真实路径`, candidates: [] });
const blocked = (note: string): ResolveResult => ({ status: "blocked", abs: "", note, candidates: [] });
const reject = (msg: string): ResolveResult => ({ status: "notfound", abs: "", note: msg, candidates: [] });

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

/** 同步版文件名查找；完全同名的优先，其次才是"包含" */
function findFilesByNameSync(root: string, name: string, limit: number): string[] {
  const exactHits: string[] = [];
  const fuzzyHits: string[] = [];
  const needle = name.toLowerCase();
  if (!needle) return [];
  const skip = new Set(["node_modules", "dist", "build", ".git", "__pycache__", "venv", ".venv"]);
  const walk = (dir: string, depth: number) => {
    if (depth < 0 || exactHits.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth - 1); continue; }
      const lower = e.name.toLowerCase();
      const rel = path.relative(root, p);
      if (isSensitivePath(rel)) continue;
      if (lower === needle) exactHits.push(rel);
      else if (lower.includes(needle) && fuzzyHits.length < limit) fuzzyHits.push(rel);
    }
  };
  walk(root, 6);
  return (exactHits.length ? exactHits : fuzzyHits).slice(0, limit);
}

/** run_command 的 cwd：必须是 root 内已存在的目录 */
export function resolveCwd(root: string, cwd?: string): string {
  if (!cwd) return path.resolve(root);
  const r = resolvePath(root, cwd);
  if (r.status === "exact" || r.status === "converged") {
    let isDir = false;
    try { isDir = fs.statSync(r.abs).isDirectory(); } catch { /* 下面统一报错 */ }
    if (isDir) return r.abs;
    throw new Error(`run_command cwd 不是目录：${cwd}`);
  }
  throw new Error(`run_command cwd 非法：${r.note}`);
}
