import fs from "node:fs/promises";
import path from "node:path";
import { IGNORE } from "../config.js";
import type { Workspace } from "../workspace.js";

/**
 * 外部 Agent（Cursor）直接改磁盘，不经过 mini-agent 的 write_file/edit_file，所以 Workspace 的 journal 里什么都没有。
 * 这里用"任务前备份、任务后比对"补上：
 *   1. 任务前：遍历项目（跳过 IGNORE），记录每个文件的 mtime:size；小的文本文件同时把内容读进内存（有数量/体积上限）。
 *   2. 任务后：再遍历一次，新增/修改/删除的文件按"事后登记"写入 Workspace.journal（recordOriginal）。
 *      之后 /undo（rollback）、/diff（changes）、"改动文件"列表都和原生后端一模一样。
 * 超出上限的大文件改动无法还原：会列在 unrecoverable 里，如实告诉用户。目录太大遍历不完时 complete=false。
 */

export const TRACK_LIMITS = {
  maxFiles: 20_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
  maxMs: 8_000,
};

type Entry = { sig: string; content?: Buffer };
export type Baseline = { root: string; files: Map<string, Entry>; complete: boolean; withContent: boolean };
export type TrackResult = {
  /** false = 目录太大/太慢没遍历完：改动统计可能不全 */
  complete: boolean;
  /** 改了、但没有备份内容所以 /undo 还原不了的文件（太大 / 只做了轻量基线） */
  unrecoverable: string[];
};

async function walk(root: string, withContent: boolean): Promise<{ files: Map<string, Entry>; complete: boolean }> {
  const files = new Map<string, Entry>();
  const deadline = Date.now() + TRACK_LIMITS.maxMs;
  let complete = true;
  let total = 0;
  const stack = [root];
  while (stack.length && complete) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;                                   // 符号链接不跟随
      if (files.size >= TRACK_LIMITS.maxFiles || Date.now() > deadline) { complete = false; break; }
      try {
        const st = await fs.stat(full);
        const entry: Entry = { sig: `${st.mtimeMs}:${st.size}` };
        if (withContent && st.size <= TRACK_LIMITS.maxFileBytes && total + st.size <= TRACK_LIMITS.maxTotalBytes) {
          entry.content = await fs.readFile(full);
          total += entry.content.length;
        }
        files.set(path.relative(root, full).split(path.sep).join("/"), entry);
      } catch { /* 刚被删除：忽略 */ }
    }
  }
  return { files, complete };
}

/** withContent=true：能还原（agent 模式）；false：只比对 mtime:size，便宜（只读模式的"有没有被改"检查） */
export async function captureBaseline(root: string, withContent: boolean): Promise<Baseline> {
  const { files, complete } = await walk(root, withContent);
  return { root, files, complete, withContent };
}

/** 比对并把改动登记进 ws；返回统计的完整性与"无法还原"的文件 */
export async function recordChanges(base: Baseline, ws: Workspace): Promise<TrackResult> {
  const now = await walk(base.root, false);
  const unrecoverable: string[] = [];
  const abs = (rel: string) => path.join(base.root, ...rel.split("/"));

  for (const [rel, cur] of now.files) {
    const before = base.files.get(rel);
    if (!before) { ws.recordOriginal(abs(rel), null); continue; }            // 新增
    if (before.sig === cur.sig) continue;
    if (before.content) ws.recordOriginal(abs(rel), before.content);          // 修改
    else unrecoverable.push(rel);
  }
  for (const [rel, before] of base.files) {                                    // 删除
    if (now.files.has(rel)) continue;
    if (before.content) ws.recordOriginal(abs(rel), before.content);
    else unrecoverable.push(rel);
  }
  return { complete: base.complete && now.complete, unrecoverable: unrecoverable.sort() };
}
