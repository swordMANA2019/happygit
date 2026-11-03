import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { resolvePath } from "../guard.js";
import type { ToolCtx } from "./ctx.js";

/**
 * 读取办公文档/PDF 的文本内容：docx / pptx / xlsx / pdf（纯文本类文件请用 read_file）。
 * 不依赖 Python 或 Office：OOXML 本质是 zip + XML，pdf 用 pdf.js 抽取文字层。
 * 只提取文字与结构，不含图片/图表本身；扫描版 PDF（无文字层）会提示需要 OCR。
 */

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_CHARS = 60_000;
export const DOC_EXT = new Set([".docx", ".pptx", ".xlsx", ".pdf"]);

const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
   .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
   .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
   .replace(/&amp;/g, "&");

/** 取出 XML 中的文本：段落标签变换行，制表符保留，其余标签丢弃 */
function xmlText(xml: string, para: string, text: string): string {
  const withBreaks = xml
    .replace(new RegExp(`</${para}>`, "g"), "\n")
    .replace(/<(w:tab|a:tab)\b[^>]*\/>/g, "\t")
    .replace(/<(w:br|a:br)\b[^>]*\/>/g, "\n");
  const re = new RegExp(`<${text}\\b[^>]*>([\\s\\S]*?)</${text}>|(\\n)|(\\t)`, "g");
  let out = "";
  for (const m of withBreaks.matchAll(re)) out += m[1] !== undefined ? decodeEntities(m[1]) : (m[2] ?? m[3] ?? "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

const numKey = (p: string) => Number(p.match(/(\d+)\.xml$/)?.[1] ?? 0);

function readDocx(files: Record<string, Uint8Array>): string {
  const main = files["word/document.xml"];
  if (!main) return "(不是有效的 docx：缺少 word/document.xml)";
  const body = xmlText(strFromU8(main), "w:p", "w:t");
  const extras = Object.keys(files)
    .filter((p) => /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(p))
    .map((p) => `[${path.basename(p)}] ${xmlText(strFromU8(files[p]), "w:p", "w:t")}`)
    .filter((s) => s.length > 12);
  return [body, ...extras].join("\n\n");
}

function readPptx(files: Record<string, Uint8Array>): string {
  const slides = Object.keys(files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => numKey(a) - numKey(b));
  if (slides.length === 0) return "(不是有效的 pptx：没有幻灯片)";
  return slides.map((p) => {
    const n = numKey(p);
    const text = xmlText(strFromU8(files[p]), "a:p", "a:t");
    const notesFile = files[`ppt/notesSlides/notesSlide${n}.xml`];
    const notes = notesFile ? xmlText(strFromU8(notesFile), "a:p", "a:t") : "";
    return `--- 幻灯片 ${n} ---\n${text || "(无文字)"}${notes ? `\n[备注] ${notes}` : ""}`;
  }).join("\n\n");
}

function readXlsx(files: Record<string, Uint8Array>): string {
  const shared: string[] = [];
  if (files["xl/sharedStrings.xml"]) {
    for (const m of strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join(""));
    }
  }
  const names = files["xl/workbook.xml"]
    ? [...strFromU8(files["xl/workbook.xml"]).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeEntities(m[1]))
    : [];
  const sheets = Object.keys(files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort((a, b) => numKey(a) - numKey(b));
  if (sheets.length === 0) return "(不是有效的 xlsx：没有工作表)";

  const MAX_ROWS = 300;
  return sheets.map((p, i) => {
    const xml = strFromU8(files[p]);
    const rows: string[] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS) { rows.push(`…（超过 ${MAX_ROWS} 行，已截断）`); break; }
      const cells: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? "";
        const t = attrs.match(/\bt="(\w+)"/)?.[1];
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = inner.match(/<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1];
        const col = attrs.match(/\br="([A-Z]+)\d+"/)?.[1] ?? "";
        const val = t === "s" && v !== undefined ? shared[Number(v)] ?? "" : inline !== undefined ? decodeEntities(inline) : v !== undefined ? decodeEntities(v) : "";
        if (val !== "") cells.push(`${col}=${val}`);
      }
      if (cells.length) rows.push(cells.join("\t"));
    }
    return `--- 工作表 ${names[i] ?? `Sheet${i + 1}`} ---\n${rows.join("\n") || "(空)"}`;
  }).join("\n\n");
}

async function readPdf(buf: Buffer, startPage?: number, endPage?: number): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text as string[];
  const s = Math.max(startPage ?? 1, 1);
  const e = Math.min(endPage ?? totalPages, totalPages);
  const out: string[] = [];
  for (let p = s; p <= e; p++) out.push(`--- 第 ${p} 页 / 共 ${totalPages} 页 ---\n${(pages[p - 1] ?? "").trim() || "(无文字层)"}`);
  const all = out.join("\n\n");
  if (!pages.some((t) => t.trim())) return `${all}\n\n[提示] 这个 PDF 没有可提取的文字层（可能是扫描件/图片），需要 OCR 才能读取。`;
  return all;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** view_image：读图片并排队，由 agent 循环作为下一条 user 消息附上（tool 消息本身不能带图片） */
export async function loadImage(ctx: ToolCtx, p: unknown): Promise<string> {
  const r = resolvePath(ctx.root, p);
  if (r.status !== "exact" && r.status !== "converged") {
    return `无法读取：${r.note}${r.candidates.length ? `\n候选：${r.candidates.join(", ")}` : ""}`;
  }
  const mime = IMAGE_MIME[path.extname(r.abs).toLowerCase()];
  if (!mime) return `view_image 只支持 ${Object.keys(IMAGE_MIME).join(" / ")}。`;
  const st = await fs.stat(r.abs);
  if (st.size > MAX_IMAGE_BYTES) return `图片过大（${(st.size / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB），请先缩小/降低分辨率。`;
  const data = await fs.readFile(r.abs);
  ctx.pendingImages.push({ path: path.relative(ctx.root, r.abs), dataUrl: `data:${mime};base64,${data.toString("base64")}` });
  return `图片已读取（${(st.size / 1024).toFixed(0)}KB），会在下一条消息里提供给你查看。`;
}

/** start_page/end_page 仅对 pdf 生效；超长内容截断并提示如何继续 */
export async function readDocument(ctx: ToolCtx, p: unknown, startPage?: number, endPage?: number): Promise<string> {
  const r = resolvePath(ctx.root, p);
  if (r.status !== "exact" && r.status !== "converged") {
    return `无法读取：${r.note}${r.candidates.length ? `\n候选：${r.candidates.join(", ")}` : ""}\n请先用 list_files 确认真实路径。`;
  }
  const ext = path.extname(r.abs).toLowerCase();
  if (!DOC_EXT.has(ext)) return `read_document 只支持 ${[...DOC_EXT].join(" / ")}；其它文本文件请用 read_file。`;

  const st = await fs.stat(r.abs);
  if (st.size > MAX_BYTES) return `文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_BYTES / 1024 / 1024}MB 上限。`;
  const buf = await fs.readFile(r.abs);

  let text: string;
  try {
    if (ext === ".pdf") text = await readPdf(buf, startPage, endPage);
    else {
      const files = unzipSync(new Uint8Array(buf));
      text = ext === ".docx" ? readDocx(files) : ext === ".pptx" ? readPptx(files) : readXlsx(files);
    }
  } catch (e: any) {
    return `[读取失败] ${path.basename(r.abs)} 无法解析（文件损坏、加密或格式不受支持）：${e?.message ?? e}`;
  }

  if (text.length > MAX_CHARS) {
    return `${text.slice(0, MAX_CHARS)}\n\n…（内容共 ${text.length} 字符，已截断到前 ${MAX_CHARS}。` +
      (ext === ".pdf" ? "用 start_page/end_page 分页读取后续部分）" : "如需后面的部分，请用 delegate 分段阅读，或让脚本把内容导出成文本再分段 read_file）");
  }
  return text || "(文档中没有可提取的文字)";
}
