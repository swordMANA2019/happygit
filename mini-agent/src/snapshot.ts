import fs from "node:fs/promises";
import path from "node:path";
import { IGNORE } from "./config.js";

/**
 * 目录快照：记录"任务前后项目里哪些文件变了"。
 *
 * 检查点（Workspace）只记录 Agent 通过 write_file/edit_file 改动的文件；
 * 但很多任务的产出是脚本生成的——例如 python 脚本生成 deck.pptx、训练脚本写出模型文件。
 * 这些文件靠 run_command 产生，检查点看不到。快照用来补上这一块：
 *   - 让界面能告诉用户"这次产出了哪些文件"；
 *   - 让技能声明的验证器（如检查 pptx）知道该检查哪个文件。
 * 注意：这些文件无法被 /undo 还原（只是被发现，不是被检查点保护）。
 */

export type Snapshot = Map<string, string>;   // 相对路径 -> "mtimeMs:size"

const MAX_ENTRIES = 20_000;
const MAX_MS = 4_000;

/** 目录太大/太慢时返回 null（放弃这项附加功能，不影响主流程） */
export async function snapshotTree(root: string): Promise<Snapshot | null> {
  const snap: Snapshot = new Map();
  const deadline = Date.now() + MAX_MS;
  let overflow = false;

  async function walk(dir: string) {
    if (overflow) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (overflow) return;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile()) continue;
      if (snap.size >= MAX_ENTRIES || Date.now() > deadline) { overflow = true; return; }
      try {
        const st = await fs.stat(full);
        snap.set(path.relative(root, full).split(path.sep).join("/"), `${Math.round(st.mtimeMs)}:${st.size}`);
      } catch { /* 文件刚被删除：忽略 */ }
    }
  }

  await walk(root);
  return overflow ? null : snap;
}

/** 前后快照之间新增或修改的文件（排除已被检查点记录的） */
export function producedFiles(before: Snapshot | null, after: Snapshot | null, exclude: string[] = []): string[] {
  if (!before || !after) return [];
  const skip = new Set(exclude);
  const out: string[] = [];
  for (const [f, sig] of after) {
    if (skip.has(f)) continue;
    if (before.get(f) !== sig) out.push(f);
  }
  return out.sort();
}
