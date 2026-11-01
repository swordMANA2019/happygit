import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const safe = (p: string) => path.resolve(ROOT, p);

function readOnlyGuard(): string | null {
  if (process.env.AGENT_READONLY === "1") {
    return "当前为只读诊断模式，禁止写文件。请先输出分析报告。";
  }
  return null;
}

export async function readFile(p: string, start?: number, end?: number): Promise<string> {
  const abs = safe(p);
  const lines = (await fs.readFile(abs, "utf-8")).split("\n");
  const s = start ?? 0;
  const e = end ?? lines.length;
  return lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join("\n");
}

export async function writeFile(p: string, content: string): Promise<string> {
  const guard = readOnlyGuard();
  if (guard) return guard;
  const abs = safe(p);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return `已写入 ${p}（${content.length} 字符）`;
}

export async function editFile(p: string, oldText: string, newText: string): Promise<string> {
  const guard = readOnlyGuard();
  if (guard) return guard;
  const abs = safe(p);
  const src = await fs.readFile(abs, "utf-8");
  const count = src.split(oldText).length - 1;
  if (count === 0) return `未找到匹配文本，请先 read_file 获取最新内容`;
  if (count > 1) return `匹配到 ${count} 处，old_text 不够唯一，请扩大上下文`;
  await fs.writeFile(abs, src.replace(oldText, newText), "utf-8");
  return `已替换 ${p}`;
}

export async function listFiles(p: string, depth = 3): Promise<string> {
  const abs = safe(p);
  const parts: string[] = [];
  async function walk(dir: string, d: number, prefix = "") {
    if (d < 0) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") && e.name !== ".agent") continue;
      parts.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory()) await walk(path.join(dir, e.name), d - 1, `${prefix}  `);
    }
  }
  await walk(abs, depth);
  return parts.join("\n") || "(空目录)";
}