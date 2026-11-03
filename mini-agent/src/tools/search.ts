import fs from "node:fs/promises";
import path from "node:path";
import { IGNORE, TEXT_EXT } from "../config.js";
import { isSensitivePath } from "../guard.js";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_FILE_BYTES = 1024 * 1024;

export async function searchCode(root: string, query: string, maxResults = 40) {
  if (!query) return "query 不能为空";
  const re = new RegExp(esc(query), "i");
  const hits: string[] = [];
  let skipped = 0;

  async function searchContent(full: string) {
    if (!TEXT_EXT.has(path.extname(full))) return;
    let text: string;
    try {
      const st = await fs.stat(full);
      if (st.size > MAX_FILE_BYTES) { skipped++; return; }
      text = await fs.readFile(full, "utf8");
    } catch {
      skipped++;
      return;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push(`${path.relative(root, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= maxResults) break;
      }
    }
  }

  async function walk(dir: string) {
    if (hits.length >= maxResults) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skipped++;               // 权限不足 / 目录被删：跳过，不要让整个搜索失败
      return;
    }
    for (const e of entries) {
      if (hits.length >= maxResults) return;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (isSensitivePath(path.relative(root, full))) continue;
      // 文件名匹配：用户常按文件名（如 mlp.py）定位文件，内容里不一定出现这个字符串
      if (re.test(e.name)) {
        hits.push(`${path.relative(root, full)}: (文件名匹配)`);
        if (hits.length >= maxResults) return;
      }
      await searchContent(full);
    }
  }

  await walk(root);
  const tail = skipped ? `\n（另有 ${skipped} 个文件/目录因过大或无法读取被跳过）` : "";
  return hits.length ? hits.join("\n") + tail : `未找到匹配：${query}${tail}`;
}
