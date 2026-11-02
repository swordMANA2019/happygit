import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execAsync = promisify(exec);

let _hasRg: boolean | undefined;
async function hasRg(root: string): Promise<boolean> {
  if (_hasRg !== undefined) return _hasRg;
  try { await execAsync("rg --version", { cwd: root, timeout: 3000 }); _hasRg = true; } catch { _hasRg = false; }
  return _hasRg;
}

export async function searchCode(root: string, query: string, maxResults = 40): Promise<string> {
  if (await hasRg(root)) {
    try {
      const q = query.replace(/"/g, '\\"');
      const { stdout } = await execAsync(`rg --line-number --no-heading --max-count=${maxResults} "${q}" .`, {
        cwd: root, timeout: 15_000, maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim() || "未找到匹配";
    } catch {}
  }
  return grepFallback(root, query, maxResults);
}

/** 按文件名查找，返回相对路径列表（用于路径纠错） */
export async function findFilesByName(root: string, name: string, limit = 10): Promise<string[]> {
  const needle = name.toLowerCase();
  const out: string[] = [];
  const walk = async (dir: string, depth = 6) => {
    if (depth < 0 || out.length >= limit) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p, depth - 1); continue; }
      if (e.name.toLowerCase() === needle || e.name.toLowerCase().includes(needle)) {
        out.push(path.relative(root, p));
        if (out.length >= limit) return;
      }
    }
  };
  try { await walk(root); } catch {}
  return out;
}

async function grepFallback(root: string, query: string, max = 40): Promise<string> {
  const results: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      try {
        const txt = await fs.readFile(p, "utf-8");
        txt.split("\n").forEach((l, i) => {
          if (l.includes(query)) results.push(`${path.relative(root, p)}:${i + 1}: ${l.trim()}`);
        });
      } catch {}
    }
  };
  await walk(root);
  return results.slice(0, max).join("\n") || "未找到匹配";
}

export { execAsync };