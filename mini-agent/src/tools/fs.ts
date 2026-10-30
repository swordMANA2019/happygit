import fs from "node:fs/promises";
import path from "node:path";
import { ROOT, IGNORE } from "../config.js";
import { insideRoot } from "../safety.js";

export async function readFile(p: string, start?: number, end?: number) {
  const abs = insideRoot(p);
  const lines = (await fs.readFile(abs, "utf8")).split("\n");
  const s = Math.max(0, (start ?? 1) - 1);
  const e = Math.min(lines.length, end ?? lines.length);
  return lines.slice(s, e).map((l, i) => `${s + i + 1}| ${l}`).join("\n");
}

export async function writeFile(p: string, content: string) {
  const abs = insideRoot(p);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return `已写入 ${path.relative(ROOT, abs)}（${content.length} 字符）`;
}

/** 精确替换，模拟 Cursor 的 diff 编辑 */
export async function editFile(p: string, oldText: string, newText: string) {
  const abs = insideRoot(p);
  const src = await fs.readFile(abs, "utf8");
  const count = src.split(oldText).length - 1;
  if (count === 0) return `未找到待替换文本，请先 read_file 确认内容`;
  if (count > 1) return `匹配到 ${count} 处，old_text 不够唯一，请扩大上下文`;
  await fs.writeFile(abs, src.replace(oldText, newText), "utf8");
  return `已修改 ${path.relative(ROOT, abs)}`;
}

export async function listFiles(p = ".", depth = 3) {
  const abs = insideRoot(p);
  const out: string[] = [];
  async function walk(dir: string, d: number) {
    if (d > depth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const rel = path.relative(ROOT, path.join(dir, e.name));
      out.push("  ".repeat(d) + e.name + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) await walk(path.join(dir, e.name), d + 1);
    }
  }
  await walk(abs, 0);
  return out.slice(0, 400).join("\n");
}