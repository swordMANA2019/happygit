import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PptApi, PptSlide } from "./bridge.js";
import { lintSlide, formatIssues, type Issue } from "./lint.js";
import { applyOps, lintTargets, touchedSlides, collectFixOps } from "./ops.js";
import { describeSlide, describeTheme, describeSelection, clip } from "./describe.js";
import { assetDirs, scanAssets, searchAssets, formatHits, type AssetDirsConfig } from "./assets.js";

/**
 * 给"会调用工具的模型"用的一层：工具定义（OpenAI function-calling 格式，MCP 也能直接转）+ 处理函数。
 * 处理函数永不抛异常——任何失败都是"观察"文本；PowerPoint 没开/没打开文稿会给出下一步该做什么。
 * 宿主（mini-agent / MCP 服务 / 你自己的程序）只需要实现 PptHost 里的几个可选能力。
 */

/* =========================================================================
 * 工具定义
 * ========================================================================= */

export type PptToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** 只读工具：宿主的"只读模式"下也可以暴露（ppt_lint 的 fix=true 在处理函数里单独拦） */
export const PPT_READ_NAMES = ["ppt_read", "ppt_lint", "ppt_look", "asset_search"] as const;
/** 会改动演示文稿或写文件的工具 */
export const PPT_WRITE_NAMES = ["ppt_edit", "ppt_open", "ppt_save"] as const;
export const PPT_TOOL_NAMES = [...PPT_READ_NAMES, ...PPT_WRITE_NAMES] as const;

export const PPT_TOOL_DEFS: PptToolDef[] = [
  { type: "function", function: {
      name: "ppt_read",
      description: "读取用户正在 PowerPoint 里打开的演示文稿的实时状态：文稿名、页数、用户当前看的页、用户当前选中了什么，以及该页每个形状的类型/位置/大小/文字/字体/颜色/填充，另含大纲和主题色/字体。任何修改前先调用。slide 省略 = 用户当前页。",
      parameters: { type: "object", properties: {
        slide: { type: "number", description: "页码（1-based），默认用户当前页" },
      } } } },
  { type: "function", function: {
      name: "ppt_edit",
      description: `批量修改当前活动演示文稿（实时生效，用户可 Ctrl+Z 撤销；首次修改前自动备份）。坐标单位 pt，画布左上角为原点（16:9 = 960x540）；颜色 RRGGBB。ops 按顺序执行，某个失败则停在那里（已执行的不回滚）。
每个 op 形如 {"op":名,"slide":页码(省略=用户当前页),...}；shape 字段写名字或 id（"selection"=用户选中的形状）；add_* 可带 name 给新形状起名供后续引用。
- add_textbox{text,left,top,width,height} / add_shape{shape,left,top,width,height,rotation?,text?} / add_line{x1,y1,x2,y2,color,weight} / add_picture{path,left,top,width?,height?,alt?}
  shape 取值：rectangle rounded_rectangle oval circle triangle right_triangle diamond hexagon octagon pentagon parallelogram trapezoid cross star heart sun moon cloud teardrop lightning smiley donut can cube chevron homeplate callout right_arrow left_arrow up_arrow down_arrow
- 格式字段（add_* 和 format 通用）：font size bold italic color align(left|center|right|justify) valign(top|middle|bottom) fill(RRGGBB|none) line(RRGGBB|none) line_width transparency(0-1) alt autosize wrap
- set_text{shape,text} / format{shape,...格式字段} / geometry{shape,left,top,width,height,rotation} / z_order{shape,action:front|back|forward|backward} / delete_shape{shape} / group{shapes:[...],name} / align{shapes,mode:left|center|right|top|middle|bottom,relative_to:slide|shapes} / distribute{shapes(≥3),direction:horizontal|vertical}
- add_slide{layout:title|title_content|title_only|blank|版式名,index?} / duplicate_slide / delete_slide / move_slide{to} / set_notes{text} / set_background{color}
- goto_slide{slide,shape?}：让 PowerPoint 窗口显示某页（shape 可选，放大视图时滚动到该形状）。改完后窗口会自动切到最后被改动的那一页，通常不必手动调用。`,
      parameters: { type: "object", properties: {
        ops: { type: "array", description: "操作列表（一次最多 40 个），能合并成一批就不要拆成多次调用", items: { type: "object" } },
      }, required: ["ops"] } } },
  { type: "function", function: {
      name: "ppt_lint",
      description: "对幻灯片做规则检查（不花 token）：出界、重叠、字号过小、文字对比度不足、文字溢出、对齐差一点、文字过多、空占位符、字体过杂等。fix=true 会自动修复其中能机械修复的并返回剩余问题。slide 省略 = 用户当前页；all=true 检查全部页。",
      parameters: { type: "object", properties: {
        slide: { type: "number" }, all: { type: "boolean" }, fix: { type: "boolean", description: "自动修复可修复的问题（agent 模式）" },
      } } } },
  { type: "function", function: {
      name: "ppt_look",
      description: "把一页渲染成图片并交给视觉模型点评（版式层次、配色、留白、图文遮挡等规则检查发现不了的审美问题）。较慢、花钱：在完成一轮 ppt_edit 并通过 ppt_lint 之后再用，同一页最多看 2 次。可用 question 指定想问什么。",
      parameters: { type: "object", properties: {
        slide: { type: "number" }, question: { type: "string", description: "想让视觉模型重点看什么，省略 = 整体评价" },
      } } } },
  { type: "function", function: {
      name: "asset_search",
      description: "在本地素材库里按关键词找图片（花、图标、logo、背景……）。query 可同时写中英文同义词。返回完整路径，供 ppt_edit 的 add_picture 使用。不联网。没找到时用 add_shape 组合绘制，或如实告诉用户缺素材。",
      parameters: { type: "object", properties: {
        query: { type: "string" }, limit: { type: "number" },
      }, required: ["query"] } } },
  { type: "function", function: {
      name: "ppt_open",
      description: "新建空白演示文稿（不带 path），或打开项目内/用户点名的 .pptx 文件。用户没有打开任何文稿而要求做 PPT 时使用。",
      parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: {
      name: "ppt_save",
      description: "保存当前演示文稿。仅当用户明确要求保存/另存时调用；不要自动保存（用户的文件由用户决定何时保存）。带 path（项目内、.pptx）= 另存为。",
      parameters: { type: "object", properties: { path: { type: "string" } } } } },
];

/* =========================================================================
 * 宿主接口
 * ========================================================================= */

export type VisionRequest = { png: Buffer; system: string; user: string; signal?: AbortSignal };

export interface PptHost {
  /** PowerPoint 桥接（PptBridge，或测试用的假对象） */
  ppt: PptApi;
  /** ppt_look 渲染出的 PNG 存放目录 */
  scratchDir: string;
  /** 修改前的备份存放目录 */
  backupDir: string;
  /** 项目根：用来显示相对路径、解析相对路径，并默认限制 ppt_save 只能另存到它里面 */
  root?: string;
  /** true = 只读：ppt_edit / ppt_open / ppt_save / ppt_lint fix 都会被拒绝 */
  readOnly?: boolean;
  /** 素材目录（数组或 ; 分隔的字符串；不传 = <root>/assets） */
  assetDirs?: AssetDirsConfig;
  /** 搜索素材时发现了这些目录：宿主可以据此授权只读访问 */
  onAssetDirs?: (dirs: string[]) => void;
  /**
   * 读取用户/模型给的文件路径前的校验（add_picture 的图片、ppt_open 的 .pptx）。
   * 默认：相对 root 解析、必须存在。宿主可以在这里接入自己的权限/授权逻辑，返回绝对路径或拒绝原因。
   */
  resolvePath?: (p: string, kind: "image" | "presentation") => Promise<{ path: string } | { error: string }>;
  /** ppt_save 另存的限制目录；默认等于 root；设为 null 不限制 */
  saveRoot?: string | null;
  /** 视觉模型：给图片和提示词，返回点评文字 */
  vision?: (req: VisionRequest) => Promise<string>;
  /** 点评结果里显示的视觉模型名 */
  visionName?: string;
  /** 没有 vision 时：把图片交给宿主（让主模型自己看）；返回 true = 宿主接收了 */
  attachImage?: (info: { path: string; dataUrl: string }) => boolean;
  /** 既没有 vision 也没有 attachImage 时，附在"不可用"提示后面的说明（例如怎么配置） */
  noVisionHint?: string;
  signal?: AbortSignal;
}

/* =========================================================================
 * 处理函数
 * ========================================================================= */

/** 把桥接/COM 的错误变成给模型的下一步指引 */
export function pptErrorText(e: any): string {
  const m = String(e?.message ?? e);
  if (m.includes("NO_POWERPOINT")) return "[PowerPoint] PowerPoint 没有运行。请用 ppt_open 新建或打开一个演示文稿（不带 path = 新建空白文稿）。";
  if (m.includes("NO_PRESENTATION")) return "[PowerPoint] PowerPoint 里没有打开的演示文稿。请用 ppt_open 新建或打开一个。";
  return `[PowerPoint] ${m}`;
}

const MAX_OPS = 40;
const IMG_EXT = /\.(png|jpe?g|gif|bmp|svg|emf|wmf|webp)$/i;
const refuseReadOnly = (what: string) => `[已拒绝] 当前为只读模式，不能${what}。`;
const relTo = (host: PptHost, p: string) => path.relative(host.root ?? process.cwd(), p);

async function resolveFile(host: PptHost, p: unknown, kind: "image" | "presentation"): Promise<{ path: string } | { error: string }> {
  if (host.resolvePath) return host.resolvePath(String(p ?? ""), kind);
  const abs = path.resolve(host.root ?? process.cwd(), String(p ?? ""));
  return existsSync(abs) ? { path: abs } : { error: `文件不存在：${abs}` };
}

export async function pptRead(host: PptHost, args: { slide?: number; outline?: boolean }): Promise<string> {
  const b = host.ppt;
  try {
    const st = await b.state();
    if (!st.running) return pptErrorText("NO_POWERPOINT");
    if (!st.active) return pptErrorText("NO_PRESENTATION");
    const lines: string[] = [];
    lines.push(`演示文稿：${st.active}${st.saved ? "" : "（有未保存的修改）"}${st.path && st.path !== st.active ? `  ${st.path}` : "（尚未保存到磁盘）"}；共 ${st.slideCount} 页；用户当前正在看第 ${st.activeSlide} 页`);
    if ((st.presentations?.length ?? 0) > 1) lines.push(`另外打开的文稿：${st.presentations!.filter((p) => p.name !== st.active).map((p) => p.name).join("、")}（操作的是当前活动文稿）`);
    lines.push(describeSelection(st.selection));
    if ((st.slideCount ?? 0) > 1 && args.outline !== false) {
      const t = await b.titles();
      lines.push("大纲：" + t.slides.map((s) => `${s.index}.${s.title ? clip(s.title.replace(/\s+/g, " "), 30) : "(无标题)"}`).join("  "));
    }
    const idx = args.slide && args.slide > 0 ? Math.floor(args.slide) : undefined;
    const sl = await b.dump(idx, true);
    lines.push("", describeSlide(sl) + describeTheme(sl));
    return lines.join("\n");
  } catch (e) { return pptErrorText(e); }
}

export async function pptEdit(host: PptHost, args: { ops?: unknown }): Promise<string> {
  if (host.readOnly) return refuseReadOnly("修改演示文稿");
  const b = host.ppt;
  if (!Array.isArray(args.ops) || args.ops.length === 0) return "[参数错误] ppt_edit 需要非空的 ops 数组。";
  if (args.ops.length > MAX_OPS) return `[参数错误] 一次最多 ${MAX_OPS} 个操作（收到 ${args.ops.length}）。请分批。`;
  const ops: any[] = [];
  for (const [i, raw] of args.ops.entries()) {
    if (!raw || typeof raw !== "object" || typeof (raw as any).op !== "string") return `[参数错误] ops[${i}] 必须是带 op 字段的对象。`;
    const op: any = { ...(raw as any) };
    if (op.op === "add_picture") {
      const r = await resolveFile(host, op.path, "image");
      if ("error" in r) return `[参数错误] ops[${i}] add_picture 的图片不可用：${r.error}。请先用 asset_search 找到真实存在的图片，不要编造路径。`;
      if (!IMG_EXT.test(r.path)) return `[参数错误] ops[${i}] 不是受支持的图片格式：${r.path}`;
      op.path = r.path;
    }
    ops.push(op);
  }
  try {
    const out = await applyOps(b, host.backupDir, ops);
    const done = out.applied.map((a) => `- ${a}`).join("\n");
    let text: string;
    if (out.ok) text = `已应用 ${out.applied.length} 个操作：\n${done}`;
    else {
      text = `${out.applied.length ? `已应用 ${out.applied.length} 个操作（第 ${out.failedAt} 个失败，其后的未执行）：\n${done}\n` : ""}[操作失败] 第 ${out.failedAt} 个操作（${(ops[(out.failedAt ?? 1) - 1] as any)?.op}）出错：${out.error}\n修正该操作后，只需重发失败的这个及其后的操作。`;
    }
    if (out.shown) text += `\n（PowerPoint 窗口已自动切到第 ${out.shown} 页，用户能直接看到改动）`;
    if (out.backup) text += `\n（已在修改前备份原文稿：${relTo(host, out.backup)}；用户也可以在 PowerPoint 里按 Ctrl+Z 撤销）`;
    if (out.applied.length) {
      const st = await b.state().catch(() => null);
      const issues: Issue[] = [];
      for (const n of touchedSlides(ops, st?.activeSlide)) {
        try { issues.push(...lintSlide(await b.dump(n)).filter((x) => x.severity !== "info")); } catch { /* 页被删了等：忽略 */ }
      }
      if (issues.length) text += `\n\n[自动规则检查] 发现 ${issues.length} 个问题（可用 ppt_lint fix=true 自动修复其中能修的）：\n${formatIssues(issues.slice(0, 8), { withFix: true })}`;
    }
    return text;
  } catch (e) { return pptErrorText(e); }
}

export async function pptLint(host: PptHost, args: { slide?: number; all?: boolean; fix?: boolean }): Promise<string> {
  const b = host.ppt;
  if (args.fix && host.readOnly) return "[已拒绝] 当前为只读模式，不能自动修复；去掉 fix 只做检查。";
  try {
    const st = await b.state();
    if (!st.running) return pptErrorText("NO_POWERPOINT");
    if (!st.active) return pptErrorText("NO_PRESENTATION");
    const target: number[] | "all" = args.all ? "all" : [args.slide && args.slide > 0 ? Math.floor(args.slide) : st.activeSlide ?? 1];
    let issues = await lintTargets(b, target);
    let head = "";
    if (args.fix) {
      const { ops, fixed } = collectFixOps(issues);
      if (ops.length) {
        const r = await applyOps(b, host.backupDir, ops);
        head = `已自动修复 ${fixed} 个问题（${r.applied.length}/${ops.length} 个操作）${r.ok ? "" : `；第 ${r.failedAt} 个操作失败：${r.error}`}。\n`;
        issues = await lintTargets(b, target);
      } else head = "没有可自动修复的问题。\n";
    }
    const where = args.all ? "全部幻灯片" : `第 ${(target as number[])[0]} 页`;
    return `${head}规则检查（${where}）：\n${formatIssues(issues, { withFix: !args.fix })}\n（规则只能发现版式硬伤；整体美观、层次、配色是否协调需要用 ppt_look 看渲染图。）`;
  } catch (e) { return pptErrorText(e); }
}

const LOOK_SYSTEM = `你是资深演示文稿设计师，正在看一张幻灯片的渲染图。只依据图片和给出的形状清单评价，不要编造看不到的内容。
输出要求：中文，简洁，最多 8 条。每条格式"问题 → 具体改法"，改法要能直接执行（指明哪个形状、往哪移/改多大/换什么颜色，坐标单位 pt，画布左上角为原点）。
重点看：信息层次（标题是否突出）、对齐与间距、留白、配色与对比度、图文是否重叠遮挡、字号可读性、视觉重心是否平衡、是否有多余或缺失的元素。
如果这页已经很好，直接说"整体良好"并只给最多 2 条锦上添花的建议。`;

function brief(sl: PptSlide): string {
  return sl.shapes.map((s) => `#${s.id} '${s.name}' ${s.kind} (${s.left},${s.top}) ${s.width}x${s.height}${s.text ? ` "${clip(s.text.replace(/\s+/g, " "), 40)}"` : ""}`).join("\n");
}

export async function pptLook(host: PptHost, args: { slide?: number; question?: string }): Promise<string> {
  const b = host.ppt;
  try {
    const st = await b.state();
    if (!st.running) return pptErrorText("NO_POWERPOINT");
    if (!st.active) return pptErrorText("NO_PRESENTATION");
    const n = args.slide && args.slide > 0 ? Math.floor(args.slide) : st.activeSlide ?? 1;
    const file = path.join(host.scratchDir, `slide-${n}-${Date.now()}.png`);
    await b.exportSlide(n, file, 1280);
    const rel = relTo(host, file);
    const dump = await b.dump(n);

    if (host.vision) {
      const data = await fs.readFile(file);
      const q = args.question?.trim() || "整体评价这页的设计并给出改进建议。";
      const name = host.visionName ?? "视觉模型";
      try {
        const text = (await host.vision({
          png: data, signal: host.signal, system: LOOK_SYSTEM,
          user: `第 ${n} 页，画布 ${dump.slideWidth}x${dump.slideHeight}pt。形状清单：\n${brief(dump)}\n\n问题：${q}`,
        })).trim();
        if (text) return `视觉模型（${name}）对第 ${n} 页的点评：\n${text}\n\n（渲染图：${rel}）`;
        return `[ppt_look] 视觉模型返回了空内容。渲染图已保存：${rel}`;
      } catch (e: any) {
        return `[ppt_look] 调用视觉模型 ${name} 失败：${e?.message ?? e}。渲染图已保存：${rel}；可改用 ppt_lint 的规则检查。`;
      }
    }

    if (host.attachImage) {
      const data = await fs.readFile(file);
      if (host.attachImage({ path: rel, dataUrl: `data:image/png;base64,${data.toString("base64")}` })) {
        return `第 ${n} 页已渲染（${rel}），图片会在下一条消息里提供给你，请据此评价版式。`;
      }
    }
    return `[ppt_look 不可用] 没有可用的视觉模型。${host.noVisionHint ? host.noVisionHint + "\n" : ""}渲染图已保存：${rel}。现在请只用 ppt_read + ppt_lint 的结果判断，并在回复里说明没有做视觉复查。`;
  } catch (e) { return pptErrorText(e); }
}

export async function assetSearch(host: PptHost, args: { query?: string; limit?: number }): Promise<string> {
  const q = String(args.query ?? "").trim();
  if (!q) return "[参数错误] 需要 query（可以同时写中英文关键词，如 \"flower 花 rose 玫瑰\"）。";
  const root = host.root ?? process.cwd();
  const dirs = assetDirs(root, host.assetDirs);
  if (dirs.length === 0) {
    return `没有配置本地素材库。把图片放到 ${path.join(root, "assets")}（可选再放 index.json 标注标签），或由使用方配置素材目录。\n没有素材时可以用 ppt_edit 的 add_shape 组合绘制简单图形（如花：圆形花心 + 一圈旋转的椭圆花瓣），不要联网下载或编造图片路径。`;
  }
  host.onAssetDirs?.(dirs);
  const assets = scanAssets(root, host.assetDirs);
  const hits = searchAssets(assets, q, Math.min(Math.max(args.limit ?? 6, 1), 12));
  if (hits.length === 0) {
    return `素材库（${assets.length} 张图片，目录：${dirs.join("；")}）里没有匹配 "${q}" 的图片。换同义词/英文再搜一次；仍没有就用 add_shape 组合绘制，或如实告诉用户缺少素材。不要编造路径。`;
  }
  return `在素材库（${assets.length} 张）中找到 ${hits.length} 个候选（按相关度排序）：\n${formatHits(hits)}\n用 ppt_edit 的 add_picture 插入时，path 直接使用上面的完整路径；只给 width 或 height 其一会保持比例。`;
}

export async function pptOpen(host: PptHost, args: { path?: string }): Promise<string> {
  if (host.readOnly) return refuseReadOnly("新建或打开演示文稿");
  const b = host.ppt;
  try {
    if (args.path) {
      const r = await resolveFile(host, args.path, "presentation");
      if ("error" in r) return `[PowerPoint] 无法打开：${r.error}`;
      if (!/\.(pptx?|pptm|potx?|ppsx?)$/i.test(r.path)) return `[PowerPoint] 不是演示文稿文件：${r.path}`;
      const o = await b.open(r.path);
      return `已打开 ${o.opened}。请用 ppt_read 查看内容。`;
    }
    const n = await b.newPresentation();
    return `已新建空白演示文稿 ${n.name}（16:9，1 页空白页，尚未保存）。请用 ppt_read 查看，再用 ppt_edit 编辑。`;
  } catch (e) { return pptErrorText(e); }
}

export async function pptSave(host: PptHost, args: { path?: string }): Promise<string> {
  if (host.readOnly) return refuseReadOnly("保存演示文稿");
  const b = host.ppt;
  try {
    let target: string | undefined;
    if (args.path) {
      target = path.resolve(host.root ?? process.cwd(), args.path);
      const limit = host.saveRoot === undefined ? host.root : host.saveRoot;
      if (limit) {
        const rel = path.relative(limit, target);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return "[已拒绝] ppt_save 只能另存到项目目录内。";
      }
      if (!/\.pptx$/i.test(target)) return "[参数错误] 路径需以 .pptx 结尾。";
    }
    const r = await b.save(target);
    return `已保存：${r.saved}`;
  } catch (e) { return pptErrorText(e); }
}

/**
 * 按工具名分发。不是 PPT 工具返回 undefined，宿主可以继续走自己的分发。
 */
export async function callPptTool(host: PptHost, name: string, args: any): Promise<string | undefined> {
  switch (name) {
    case "ppt_read": return pptRead(host, args ?? {});
    case "ppt_edit": return pptEdit(host, args ?? {});
    case "ppt_lint": return pptLint(host, args ?? {});
    case "ppt_look": return pptLook(host, args ?? {});
    case "asset_search": return assetSearch(host, args ?? {});
    case "ppt_open": return pptOpen(host, args ?? {});
    case "ppt_save": return pptSave(host, args ?? {});
    default: return undefined;
  }
}
