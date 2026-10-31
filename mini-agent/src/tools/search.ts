import fs from "node:fs/promises";
import path from "node:path";
import { ROOT, IGNORE, TEXT_EXT } from "../config.js";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function searchCode(query: string, maxResults = 40) {
  const re = new RegExp(esc(query), "i");
  const hits: string[] = [];

  async function walk(dir: string) {
    if (hits.length >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (hits.length >= maxResults) return;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (TEXT_EXT.has(path.extname(e.name))) {
        const lines = (await fs.readFile(full, "utf8")).split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${path.relative(ROOT, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= maxResults) break;
          }
        }
      }
    }
  }

  await walk(ROOT);
  return hits.length ? hits.join("\n") : `未找到匹配：${query}`;
}