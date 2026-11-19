import fs from "node:fs/promises";
import path from "node:path";
import { client } from "../llm.js";
import { VISION_MODEL, extraBodyFor } from "../config.js";
import type { ToolCtx } from "./ctx.js";
import { resolveForRead, isReadable } from "./fs.js";
import { PptBridge, type EditResult, type PptShape, type PptSlide } from "../office/ppt.js";
import { lintSlide, formatIssues, type Issue } from "../office/lint.js";
import { assetDirs, scanAssets, searchAssets, formatHits } from "../office/assets.js";

/**
 * PowerPoint 工具的实现（agent.ts 的 dispatch 调用）。
 * 约定：永不抛异常——任何失败都是"观察"文本；PowerPoint 没开/没打开文稿给出下一步该做什么。
 */

const PH_NAME: Record<number, string> = { 1: "title", 2: "body", 3: "center_title", 4: "subtitle", 7: "object", 8: "chart", 12: "table", 13: "slide_number", 15: "footer", 16: "date", 18: "picture" };

export function pptErr(e: any): string {
  const m = String(e?.message ?? e);
  if (m.includes("NO_POWERPOINT")) return "[PowerPoint] PowerPoint 没有运行。请用 ppt_open 新建或打开一个演示文稿（不带 path = 新建空白文稿）。";
  if (m.includes("NO_PRESENTATION")) return "[PowerPoint] PowerPoint 里没有打开的演示文稿。请用 ppt_open 新建或打开一个。";
  return `[PowerPoint] ${m}`;
}

const need = (ctx: ToolCtx): PptBridge | string =>
  ctx.ppt ?? "[PowerPoint] 当前环境没有启用 PowerPoint 控制（仅 Windows + 桌面版 PowerPoint；AGENT_PPT=0 会关闭）。";

/* ---------- 文本化 ---------- */

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function describeShape(s: PptShape): string {
  const kind = s.kind === "placeholder" ? `placeholder(${PH_NAME[s.placeholder ?? -1] ?? s.placeholder})` : s.kind;
  const parts = [`[z${s.z}] #${s.id} '${s.name}' ${kind} (${s.left},${s.top}) ${s.width}x${s.height}${s.rotation ? ` rot${s.rotation}` : ""}${s.visible ? "" : " 隐藏"}`];
  if (s.children) parts.push(`含${s.children}个子形状`);
  if (s.fill) parts.push(`fill #${s.fill}`);
  if (s.line) parts.push(`line #${s.line}${s.lineWidth ? ` ${s.lineWidth}pt` : ""}`);
  if (s.text) {
    const font = `${s.font ?? ""} ${s.size && s.size < 400 ? s.size + "pt" : "混合字号"}${s.bold ? " bold" : ""} #${s.color ?? "?"}`.trim();
    parts.push(`文字(${s.paragraphs ?? 1}段, ${font})："${clip(s.text.replace(/\r/g, " / ").replace(/\n/g, " / "), 140)}"`);
    if (s.textHeight && s.height && s.textHeight > s.height) parts.push(`⚠文字高${s.textHeight}>框高${s.height}`);
  }
  if (s.alt) parts.push(`alt:"${clip(s.alt, 40)}"`);
  return "  " + parts.join(" | ");
}

export function describeSlide(sl: PptSlide): string {
  const head = `第 ${sl.index}/${sl.slideCount} 页，版式「${sl.layout}」，画布 ${sl.slideWidth}x${sl.slideHeight}pt（左上角为原点，单位 pt）${sl.background ? `，背景 #${sl.background}` : ""}`;
  const body = sl.shapes.length ? sl.shapes.map(describeShape).join("\n") : "  （本页没有任何形状）";
  const notes = sl.notes?.trim() ? `\n备注：${clip(sl.notes.trim(), 200)}` : "";
  return `${head}\n${body}${notes}`;
}

function describeTheme(sl: PptSlide): string {
  const t = sl.theme;
  if (!t) return "";
  const c = t.colors ?? {};
  const pick = ["dark1", "light1", "dark2", "light2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].filter((k) => c[k]).map((k) => `${k}=#${c[k]}`).join(" ");
  return `\n主题：标题字体 ${t.majorFont ?? "?"}，正文字体 ${t.minorFont ?? "?"}；${pick}`;
}

/* ---------- ppt_read ---------- */

export async function pptRead(ctx: ToolCtx, args: { slide?: number; outline?: boolean }): Promise<string> {
  const b = need(ctx); if (typeof b === "string") return b;
  try {
    const st = await b.state();
    if (!st.running) return pptErr("NO_POWERPOINT");
    if (!st.active) return pptErr("NO_PRESENTATION");
    const lines: string[] = [];
    lines.push(`演示文稿：${st.active}${st.saved ? "" : "（有未保存的修改）"}${st.path && st.path !== st.active ? `  ${st.path}` : "（尚未保存到磁盘）"}；共 ${st.slideCount} 页；用户当前正在看第 ${st.activeSlide} 页`);
    if ((st.presentations?.length ?? 0) > 1) lines.push(`另外打开的文稿：${st.presentations!.filter((p) => p.name !== st.active).map((p) => p.name).join("、")}（操作的是当前活动文稿）`);
    const sel = st.selection;
    if (sel && sel.type !== "none") {
      lines.push(`用户当前选中：${sel.type === "shapes" ? `形状 ${sel.shapes?.map((s) => `#${s.id} '${s.name}'`).join("、")}（用户说"这个/它"通常指它；ppt_edit 的 shape 可写 "selection"）` : sel.type === "slides" ? `缩略图中的第 ${sel.slides?.join("、")} 页` : sel.text ? `一段文字："${clip(sel.text, 80)}"` : "光标在某个文本框里（没有选中文字）"}`);
    } else lines.push("用户当前没有选中任何东西。");
    if ((st.slideCount ?? 0) > 1 && (args.outline !== false)) {
      const t = await b.titles();
      lines.push("大纲：" + t.slides.map((s) => `${s.index}.${s.title ? clip(s.title.replace(/\s+/g, " "), 30) : "(无标题)"}`).join("  "));
    }
    const idx = args.slide && args.slide > 0 ? Math.floor(args.slide) : undefined;
    const sl = await b.dump(idx, true);
    lines.push("", describeSlide(sl) + describeTheme(sl));
    return lines.join("\n");
  } catch (e) { return pptErr(e); }
}

/* ---------- 备份 + 编辑 ---------- */

/** 本会话第一次改某个文稿之前，用 SaveCopyAs 留一份（不动用户的文件、不影响"已保存"状态）。返回备份路径或 null */
export async function ensureBackup(b: PptBridge, root: string): Promise<string | null> {
  try {
    const st = await b.state();
    if (!st.active) return null;
    const key = `${st.path ?? ""}|${st.active}`;
    if (b.backedUp.has(key)) return null;
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const base = st.active.replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fff-]+/g, "_");
    const file = path.join(root, ".agent", "backups", "ppt", `${base}-${stamp}.pptx`);
    await b.backup(file);
    b.backedUp.add(key);
    return file;
  } catch { return null; }
}

export type ApplyOutcome = EditResult & { backup?: string | null };
export async function applyOps(b: PptBridge, root: string, ops: unknown[]): Promise<ApplyOutcome> {
  const backup = await ensureBackup(b, root);
  const r = await b.edit(ops);
  return { ...r, backup };
}

function touchedSlides(ops: any[], active: number | undefined): number[] {
  const s = new Set<number>();
  for (const o of ops) {
    if (typeof o?.slide === "number") s.add(o.slide);
    else if (o?.op !== "add_slide" && o?.op !== "delete_slide" && o?.op !== "move_slide" && active) s.add(active);
  }
  return [...s].slice(0, 3);
}

const MAX_OPS = 40;

export async function pptEdit(ctx: ToolCtx, args: { ops?: unknown }): Promise<string> {
  const b = need(ctx); if (typeof b === "string") return b;
  if (!Array.isArray(args.ops) || args.ops.length === 0) return "[参数错误] ppt_edit 需要非空的 ops 数组。";
  if (args.ops.length > MAX_OPS) return `[参数错误] 一次最多 ${MAX_OPS} 个操作（收到 ${args.ops.length}）。请分批。`;
  const ops: any[] = [];
  for (const [i, raw] of args.ops.entries()) {
    if (!raw || typeof raw !== "object" || typeof (raw as any).op !== "string") return `[参数错误] ops[${i}] 必须是带 op 字段的对象。`;
    const op: any = { ...(raw as any) };
    if (op.op === "add_picture") {
      const r = await resolveForRead(ctx, op.path);
      if (!isReadable(r)) return `[参数错误] ops[${i}] add_picture 的图片不可用：${r.note}。请先用 asset_search 找到真实存在的图片，不要编造路径。`;
      if (!/\.(png|jpe?g|gif|bmp|svg|emf|wmf|webp)$/i.test(r.abs)) return `[参数错误] ops[${i}] 不是受支持的图片格式：${r.abs}`;
      op.path = r.abs;
    }
    ops.push(op);
  }
  try {
    const out = await applyOps(b, ctx.root, ops);
    const done = out.applied.map((a) => `- ${a}`).join("\n");
    let text: string;
    if (out.ok) text = `已应用 ${out.applied.length} 个操作：\n${done}`;
    else {
      text = `${out.applied.length ? `已应用 ${out.applied.length} 个操作（第 ${out.failedAt} 个失败，其后的未执行）：\n${done}\n` : ""}[操作失败] 第 ${out.failedAt} 个操作（${(ops[(out.failedAt ?? 1) - 1] as any)?.op}）出错：${out.error}\n修正该操作后，只需重发失败的这个及其后的操作。`;
    }
    if (out.shown) text += `\n（PowerPoint 窗口已自动切到第 ${out.shown} 页，用户能直接看到改动）`;
    if (out.backup) text += `\n（已在修改前备份原文稿：${path.relative(ctx.root, out.backup)}；用户也可以在 PowerPoint 里按 Ctrl+Z 撤销）`;
    if (out.applied.length) {
      const st = await b.state().catch(() => null);
      const issues: Issue[] = [];
      for (const n of touchedSlides(ops, st?.activeSlide)) {
        try { issues.push(...lintSlide(await b.dump(n)).filter((x) => x.severity !== "info")); } catch { /* 页被删了等：忽略 */ }
      }
      if (issues.length) text += `\n\n[自动规则检查] 发现 ${issues.length} 个问题（可用 ppt_lint fix=true 自动修复其中能修的）：\n${formatIssues(issues.slice(0, 8), { withFix: true })}`;
    }
    return text;
  } catch (e) { return pptErr(e); }
}

/* ---------- ppt_lint ---------- */

export async function lintTargets(b: PptBridge, slides: number[] | "all"): Promise<Issue[]> {
  let list: number[];
  if (slides === "all") list = (await b.titles()).slides.map((s) => s.index);
  else list = slides;
  const out: Issue[] = [];
  for (const n of list.slice(0, 60)) out.push(...lintSlide(await b.dump(n)));
  return out;
}

export async function pptLint(ctx: ToolCtx, args: { slide?: number; all?: boolean; fix?: boolean }): Promise<string> {
  const b = need(ctx); if (typeof b === "string") return b;
  if (args.fix && ctx.mode === "ask") return "[已拒绝] 当前为只读模式，不能自动修复；去掉 fix 只做检查。";
  try {
    const st = await b.state();
    if (!st.running) return pptErr("NO_POWERPOINT");
    if (!st.active) return pptErr("NO_PRESENTATION");
    const target: number[] | "all" = args.all ? "all" : [args.slide && args.slide > 0 ? Math.floor(args.slide) : st.activeSlide ?? 1];
    let issues = await lintTargets(b, target);
    let head = "";
    if (args.fix) {
      const seen = new Set<string>();
      const ops: unknown[] = [];
      let n = 0;
      for (const x of issues) {
        if (!x.fix) continue;
        n++;
        for (const op of x.fix.ops) { const k = JSON.stringify(op); if (!seen.has(k)) { seen.add(k); ops.push(op); } }
      }
      if (ops.length) {
        const r = await applyOps(b, ctx.root, ops);
        head = `已自动修复 ${n} 个问题（${r.applied.length}/${ops.length} 个操作）${r.ok ? "" : `；第 ${r.failedAt} 个操作失败：${r.error}`}。\n`;
        issues = await lintTargets(b, target);
      } else head = "没有可自动修复的问题。\n";
    }
    const where = args.all ? "全部幻灯片" : `第 ${target[0]} 页`;
    return `${head}规则检查（${where}）：\n${formatIssues(issues, { withFix: !args.fix })}\n（规则只能发现版式硬伤；整体美观、层次、配色是否协调需要用 ppt_look 看渲染图。）`;
  } catch (e) { return pptErr(e); }
}

/* ---------- ppt_look：渲染 → 视觉模型点评 ---------- */

const LOOK_SYSTEM = `你是资深演示文稿设计师，正在看一张幻灯片的渲染图。只依据图片和给出的形状清单评价，不要编造看不到的内容。
输出要求：中文，简洁，最多 8 条。每条格式"问题 → 具体改法"，改法要能直接执行（指明哪个形状、往哪移/改多大/换什么颜色，坐标单位 pt，画布左上角为原点）。
重点看：信息层次（标题是否突出）、对齐与间距、留白、配色与对比度、图文是否重叠遮挡、字号可读性、视觉重心是否平衡、是否有多余或缺失的元素。
如果这页已经很好，直接说"整体良好"并只给最多 2 条锦上添花的建议。`;

function brief(sl: PptSlide): string {
  return sl.shapes.map((s) => `#${s.id} '${s.name}' ${s.kind} (${s.left},${s.top}) ${s.width}x${s.height}${s.text ? ` "${clip(s.text.replace(/\s+/g, " "), 40)}"` : ""}`).join("\n");
}

export async function pptLook(ctx: ToolCtx, args: { slide?: number; question?: string }): Promise<string> {
  const b = need(ctx); if (typeof b === "string") return b;
  try {
    const st = await b.state();
    if (!st.running) return pptErr("NO_POWERPOINT");
    if (!st.active) return pptErr("NO_PRESENTATION");
    const n = args.slide && args.slide > 0 ? Math.floor(args.slide) : st.activeSlide ?? 1;
    const file = path.join(ctx.root, ".agent", "scratch", "ppt", `slide-${n}-${Date.now()}.png`);
    await b.exportSlide(n, file, 1280);
    const rel = path.relative(ctx.root, file);
    const dump = await b.dump(n);

    if (VISION_MODEL) {
      const data = await fs.readFile(file);
      const q = args.question?.trim() || "整体评价这页的设计并给出改进建议。";
      try {
        const resp = await client.chat.completions.create({
          ...extraBodyFor(VISION_MODEL),
          model: VISION_MODEL,
          temperature: 0.2,
          max_tokens: 900,
          messages: [
            { role: "system", content: LOOK_SYSTEM },
            { role: "user", content: [
              { type: "text", text: `第 ${n} 页，画布 ${dump.slideWidth}x${dump.slideHeight}pt。形状清单：\n${brief(dump)}\n\n问题：${q}` },
              { type: "image_url", image_url: { url: `data:image/png;base64,${data.toString("base64")}` } },
            ] },
          ],
        } as any, { signal: ctx.signal }) as any;
        const text = String(resp.choices?.[0]?.message?.content ?? "").trim();
        if (text) return `视觉模型（${VISION_MODEL}）对第 ${n} 页的点评：\n${text}\n\n（渲染图：${rel}）`;
        return `[ppt_look] 视觉模型返回了空内容。渲染图已保存：${rel}`;
      } catch (e: any) {
        return `[ppt_look] 调用视觉模型 ${VISION_MODEL} 失败：${e?.message ?? e}。渲染图已保存：${rel}；可改用 ppt_lint 的规则检查。`;
      }
    }

    if (process.env.AGENT_VISION === "1") {
      const data = await fs.readFile(file);
      ctx.pendingImages.push({ path: rel, dataUrl: `data:image/png;base64,${data.toString("base64")}` });
      return `第 ${n} 页已渲染（${rel}），图片会在下一条消息里提供给你，请据此评价版式。`;
    }
    return `[ppt_look 不可用] 没有配置视觉模型：设置 AGENT_VISION_MODEL=<支持图片的模型名>（推荐，点评由它完成），或 AGENT_VISION=1（主模型自己看图）。\n渲染图已保存：${rel}。现在请只用 ppt_read + ppt_lint 的结果判断，并在回复里说明没有做视觉复查。`;
  } catch (e) { return pptErr(e); }
}

/* ---------- asset_search ---------- */

export async function assetSearch(ctx: ToolCtx, args: { query?: string; limit?: number }): Promise<string> {
  const q = String(args.query ?? "").trim();
  if (!q) return "[参数错误] 需要 query（可以同时写中英文关键词，如 \"flower 花 rose 玫瑰\"）。";
  const dirs = assetDirs(ctx.root);
  if (dirs.length === 0) {
    return `没有配置本地素材库。把图片放到 ${path.join(ctx.root, "assets")}（可选再放 index.json 标注标签），或设置 AGENT_ASSETS_DIR=目录1;目录2。\n没有素材时可以用 ppt_edit 的 add_shape 组合绘制简单图形（如花：圆形花心 + 一圈旋转的椭圆花瓣），不要联网下载或编造图片路径。`;
  }
  for (const d of dirs) ctx.extraRoots.add(d);
  const assets = scanAssets(ctx.root);
  const hits = searchAssets(assets, q, Math.min(Math.max(args.limit ?? 6, 1), 12));
  if (hits.length === 0) {
    return `素材库（${assets.length} 张图片，目录：${dirs.join("；")}）里没有匹配 "${q}" 的图片。换同义词/英文再搜一次；仍没有就用 add_shape 组合绘制，或如实告诉用户缺少素材。不要编造路径。`;
  }
  return `在素材库（${assets.length} 张）中找到 ${hits.length} 个候选（按相关度排序）：\n${formatHits(hits)}\n用 ppt_edit 的 add_picture 插入时，path 直接使用上面的完整路径；只给 width 或 height 其一会保持比例。`;
}

/* ---------- ppt_open / ppt_save ---------- */

export async function pptOpen(ctx: ToolCtx, args: { path?: string }): Promise<string> {
  const b = need(ctx); if (typeof b === "string") return b;
  try {
    if (args.path) {
      const r = await resolveForRead(ctx, args.path);
      if (!isReadable(r)) return `[PowerPoint] 无法打开：${r.note}`;
      if (!/\.(pptx?|pptm|potx?|ppsx?)$/i.test(r.abs)) return `[PowerPoint] 不是演示文稿文件：${r.abs}`;
      const o = await b.open(r.abs);
      return `已打开 ${o.opened}。请用 ppt_read 查看内容。`;
    }
    const n = await b.newPresentation();
    return `已新建空白演示文稿 ${n.name}（16:9，1 页空白页，尚未保存）。请用 ppt_read 查看，再用 ppt_edit 编辑。`;
  } catch (e) { return pptErr(e); }
}

export async function pptSave(ctx: ToolCtx, args: { path?: string }): Promise<string> {
  const b = need(ctx); if (typeof b === "string") return b;
  try {
    let target: string | undefined;
    if (args.path) {
      target = path.resolve(ctx.root, args.path);
      const rel = path.relative(ctx.root, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return "[已拒绝] ppt_save 只能另存到项目目录内。";
      if (!/\.pptx$/i.test(target)) return "[参数错误] 路径需以 .pptx 结尾。";
    }
    const r = await b.save(target);
    return `已保存：${r.saved}`;
  } catch (e) { return pptErr(e); }
}
