import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIRS } from "../config.js";

/**
 * 本地素材库：模型说“插一朵花”时，不联网、不生成，而是在本地素材目录里按关键词找图。
 * 目录来源：AGENT_ASSETS_DIR（; 分隔，可多个），否则 <项目>/assets 与 <项目>/.agent/assets。
 * 每个目录里可选放一个 index.json，给图片补充标签/描述/许可证（不放也能按文件名和文件夹名搜）：
 *   [{ "file": "flowers/rose.png", "tags": ["flower","rose","花","玫瑰"], "description": "红色玫瑰", "license": "CC0" }]
 *   或 { "flowers/rose.png": { "tags": [...], "description": "...", "license": "..." } }
 */

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".emf", ".wmf", ".webp"]);
const SKIP_DIR = new Set(["node_modules", ".git", "__pycache__"]);
const MAX_FILES = 5000;

export type Asset = { path: string; rel: string; tags: string[]; description: string; license?: string; bytes: number };
export type AssetHit = Asset & { score: number };

export function assetDirs(root: string): string[] {
  const dirs = ASSETS_DIRS
    ? ASSETS_DIRS.split(";").map((s) => s.trim()).filter(Boolean).map((d) => path.resolve(root, d))
    : [path.join(root, "assets"), path.join(root, ".agent", "assets")];
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

type Meta = { tags?: string[]; description?: string; license?: string };
function readIndex(dir: string): Map<string, Meta> {
  const m = new Map<string, Meta>();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    const put = (file: string, meta: any) => {
      if (typeof file !== "string") return;
      m.set(path.normalize(file).toLowerCase(), {
        tags: Array.isArray(meta?.tags) ? meta.tags.map(String) : typeof meta?.tags === "string" ? String(meta.tags).split(/[,，;；\s]+/) : [],
        description: meta?.description ? String(meta.description) : undefined,
        license: meta?.license ? String(meta.license) : undefined,
      });
    };
    if (Array.isArray(raw)) for (const e of raw) put(e?.file, e);
    else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) put(k, v);
  } catch { /* 没有 index.json 或格式错误：只按文件名搜索 */ }
  return m;
}

export function scanAssets(root: string): Asset[] {
  const out: Asset[] = [];
  for (const dir of assetDirs(root)) {
    const idx = readIndex(dir);
    const walk = (d: string, depth: number) => {
      if (out.length >= MAX_FILES || depth > 6) return;
      let ents: fs.Dirent[];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (out.length >= MAX_FILES) return;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, depth + 1); continue; }
        if (!e.isFile() || !IMG_EXT.has(path.extname(e.name).toLowerCase())) continue;
        const rel = path.relative(dir, p);
        const meta = idx.get(path.normalize(rel).toLowerCase());
        let bytes = 0; try { bytes = fs.statSync(p).size; } catch { /* ignore */ }
        out.push({ path: p, rel: rel.split(path.sep).join("/"), tags: meta?.tags ?? [], description: meta?.description ?? "", license: meta?.license, bytes });
      }
    };
    walk(dir, 0);
  }
  return out;
}

/** 英文按单词切（并拆 camelCase / 下划线 / 连字符），中文按单字 + 相邻二字词 */
function tokens(s: string): string[] {
  const out: string[] = [];
  const spaced = s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  for (const w of spaced.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)) {
    if (/[\u4e00-\u9fff]/.test(w)) {
      const cjk = [...w].filter((c) => /[\u4e00-\u9fff]/.test(c));
      out.push(...cjk);
      for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk[i] + cjk[i + 1]);
      const latin = w.replace(/[\u4e00-\u9fff]+/g, " ").split(" ").filter(Boolean);
      out.push(...latin);
    } else out.push(w);
  }
  return out;
}

export function searchAssets(assets: Asset[], query: string, limit = 8): AssetHit[] {
  const q = [...new Set(tokens(query))].filter((t) => t.length > 0);
  const whole = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const hits: AssetHit[] = [];
  for (const a of assets) {
    const nameToks = new Set(tokens(path.basename(a.rel, path.extname(a.rel))));
    const dirToks = new Set(tokens(path.dirname(a.rel)));
    const tagToks = new Set(a.tags.flatMap(tokens));
    const descLow = a.description.toLowerCase();
    let score = 0;
    for (const t of q) {
      if (tagToks.has(t)) score += 4;
      if (nameToks.has(t)) score += 3;
      if (dirToks.has(t)) score += 1.5;
      if (descLow.includes(t)) score += 1.5;
      else if (t.length >= 3 && a.rel.toLowerCase().includes(t)) score += 1;   // 子串（如 sunflower 命中 flower）
    }
    if (a.tags.some((t) => t.toLowerCase() === whole)) score += 4;
    if (score > 0) hits.push({ ...a, score });
  }
  return hits.sort((x, y) => y.score - x.score || x.bytes - y.bytes).slice(0, limit);
}

export function formatHits(hits: AssetHit[]): string {
  return hits.map((h, i) =>
    `${i + 1}. ${h.path}\n   ${[h.description, h.tags.length ? `标签: ${h.tags.join(",")}` : "", h.license ? `许可: ${h.license}` : "", `${Math.max(1, Math.round(h.bytes / 1024))}KB`].filter(Boolean).join(" | ")}`).join("\n");
}
