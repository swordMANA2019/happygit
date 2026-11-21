import type { PptShape, PptSlide, PptState } from "./bridge.js";

/**
 * 把 dump/state 变成紧凑的、给模型（或人）读的文本。
 * 文字内容是中文（和工具的提示一致）；坐标单位 pt，画布左上角为原点。
 */

const PH_NAME: Record<number, string> = { 1: "title", 2: "body", 3: "center_title", 4: "subtitle", 7: "object", 8: "chart", 12: "table", 13: "slide_number", 15: "footer", 16: "date", 18: "picture" };

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export function describeShape(s: PptShape): string {
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

export function describeTheme(sl: PptSlide): string {
  const t = sl.theme;
  if (!t) return "";
  const c = t.colors ?? {};
  const pick = ["dark1", "light1", "dark2", "light2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].filter((k) => c[k]).map((k) => `${k}=#${c[k]}`).join(" ");
  return `\n主题：标题字体 ${t.majorFont ?? "?"}，正文字体 ${t.minorFont ?? "?"}；${pick}`;
}

/** 用户当前选中了什么（一行文字） */
export function describeSelection(sel: PptState["selection"]): string {
  if (!sel || sel.type === "none") return "用户当前没有选中任何东西。";
  const what =
    sel.type === "shapes" ? `形状 ${sel.shapes?.map((s) => `#${s.id} '${s.name}'`).join("、")}（用户说"这个/它"通常指它；ppt_edit 的 shape 可写 "selection"）`
    : sel.type === "slides" ? `缩略图中的第 ${sel.slides?.join("、")} 页`
    : sel.text ? `一段文字："${clip(sel.text, 80)}"` : "光标在某个文本框里（没有选中文字）";
  return `用户当前选中：${what}`;
}
