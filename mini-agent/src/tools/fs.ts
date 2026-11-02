import fs from "node:fs/promises";
import path from "node:path";
import { resolvePath, checkAllowed } from "../guard.js";

const READONLY = () => (process.env.AGENT_READONLY === "1" ? "只读诊断模式，禁止写文件" : null);

export async function readFile(
  root: string,
  p: unknown,
  start?: number,
  end?: number
): Promise<string> {
  const r = resolvePath(root, p);
  if (r.status !== "exact") return hint(r, "读取");
  const content = await fs.readFile(r.abs, "utf-8");
  const lines = content.split("\n");
  const s = start ?? 0;
  const e = end ?? lines.length;
  return lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join("\n");
}

export async function writeFile(
  root: string,
  sessionId: string | undefined,
  p: unknown,
  content: string
): Promise<string> {
  const g = READONLY();
  if (g) return g;
  const r = resolvePath(root, p);
  if (r.status !== "exact" && r.status !== "converged") return hint(r, "写入");
  const block = checkAllowed(sessionId, r.abs);
  if (block) return block;
  await fs.mkdir(path.dirname(r.abs), { recursive: true });
  await fs.writeFile(r.abs, content, "utf-8");
  console.error(`[audit] WRITE ${r.abs}`);
  return `已写入 ${p}`;
}

export async function editFile(
  root: string,
  sessionId: string | undefined,
  p: unknown,
  oldText: string,
  newText: string
): Promise<string> {
  const g = READONLY();
  if (g) return g;
  const r = resolvePath(root, p);
  if (r.status !== "exact") return hint(r, "编辑");
  const block = checkAllowed(sessionId, r.abs);
  if (block) return block;
  const src = await fs.readFile(r.abs, "utf-8");
  const n = src.split(oldText).length - 1;
  if (n === 0) return `未找到匹配，请先 read_file 获取最新内容`;
  if (n > 1) return `匹配 ${n} 处，old_text 不够唯一，请扩大上下文`;
  await fs.writeFile(r.abs, src.replace(oldText, newText), "utf-8");
  console.error(`[audit] EDIT ${r.abs}`);
  return `已替换 ${p}`;
}

export async function listFiles(
  root: string,
  p: unknown,
  depth = 3
): Promise<string> {
  const r = resolvePath(root, p);
  if (r.status !== "exact" && r.status !== "converged") return hint(r, "列出");
  const parts: string[] = [];
  const walk = async (dir: string, d: number, pre = "") => {
    if (d < 0) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") && e.name !== ".agent") continue;
      parts.push(`${pre}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory()) await walk(path.join(dir, e.name), d - 1, `${pre}  `);
    }
  };
  await walk(r.abs, depth);
  return parts.join("\n") || "(空目录)";
}

function hint(r: { status: string; note: string; candidates: string[] }, op: string): string {
  const head = `无法${op}：${r.note}`;
  if (r.candidates.length === 1) {
    return `${head}\n你是不是想操作这个文件？→ ${r.candidates[0]}（请用该相对路径重试）`;
  }
  if (r.candidates.length > 1) {
    return `${head}\n候选：${r.candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n请用上述准确路径重试，或用 list_files 进一步确认。`;
  }
  return `${head}\n请先用 list_files / search_code 确认真实路径后再操作。`;
}