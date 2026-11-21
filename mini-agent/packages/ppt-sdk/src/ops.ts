import path from "node:path";
import type { EditResult, PptApi } from "./bridge.js";
import { lintSlide, type Issue } from "./lint.js";

/**
 * 编辑相关的共用逻辑：修改前备份、批量应用、对多页做规则检查。
 * 不依赖任何 agent 框架，脚本、MCP 服务、mini-agent 都直接用。
 */

/**
 * 本会话第一次改某个文稿之前，用 SaveCopyAs 留一份（不动用户的文件、不影响"已保存"状态）。
 * 同一个文稿只备份一次；返回备份路径，已备份过/没有文稿/失败返回 null。
 */
export async function ensureBackup(b: PptApi, backupDir: string): Promise<string | null> {
  try {
    const st = await b.state();
    if (!st.active) return null;
    const key = `${st.path ?? ""}|${st.active}`;
    if (b.backedUp.has(key)) return null;
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const base = st.active.replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fff-]+/g, "_");
    const file = path.join(backupDir, `${base}-${stamp}.pptx`);
    await b.backup(file);
    b.backedUp.add(key);
    return file;
  } catch { return null; }
}

export type ApplyOutcome = EditResult & { backup?: string | null };

/** 备份（如需）+ 应用一批操作 */
export async function applyOps(b: PptApi, backupDir: string, ops: unknown[], opts: { reveal?: boolean } = {}): Promise<ApplyOutcome> {
  const backup = await ensureBackup(b, backupDir);
  const r = await b.edit(ops, opts.reveal ?? true);
  return { ...r, backup };
}

/** 这批操作动到了哪几页（最多 3 页）：没写 slide 的操作作用于用户当前页 */
export function touchedSlides(ops: any[], active: number | undefined): number[] {
  const s = new Set<number>();
  for (const o of ops) {
    if (typeof o?.slide === "number") s.add(o.slide);
    else if (o?.op !== "add_slide" && o?.op !== "delete_slide" && o?.op !== "move_slide" && active) s.add(active);
  }
  return [...s].slice(0, 3);
}

/** 对指定页（或全部页）做规则检查 */
export async function lintTargets(b: PptApi, slides: number[] | "all"): Promise<Issue[]> {
  const list = slides === "all" ? (await b.titles()).slides.map((s) => s.index) : slides;
  const out: Issue[] = [];
  for (const n of list.slice(0, 60)) out.push(...lintSlide(await b.dump(n)));
  return out;
}

/** 把一组问题自带的修复操作合并（相同操作去重），返回操作列表和涉及的问题数 */
export function collectFixOps(issues: Issue[]): { ops: unknown[]; fixed: number } {
  const seen = new Set<string>();
  const ops: unknown[] = [];
  let fixed = 0;
  for (const x of issues) {
    if (!x.fix) continue;
    fixed++;
    for (const op of x.fix.ops) {
      const k = JSON.stringify(op);
      if (!seen.has(k)) { seen.add(k); ops.push(op); }
    }
  }
  return { ops, fixed };
}
