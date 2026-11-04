import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { diffOps, type FileChange } from "../workspace.js";

/**
 * 高亮 diff 视图（对应 Cursor 里改完代码后的 diff 面板）：
 *   - 摘要：每个文件 `+新增 −删除`（任务结束后自动打印）
 *   - /diff [n|路径]  终端里的高亮视图：红/绿整行底色 + 行内（词级）加深 + 新旧行号 + 上下文折叠
 *   - /diff html      生成自包含的 HTML（每个文件可点击展开/折叠），并尽力用浏览器打开
 *   - /diff ide [n]   用 Cursor / VS Code 自带的 diff 编辑器打开（要求命令行 `cursor` 或 `code` 在 PATH 里）
 */

/* =========================== 数据：把前后内容变成 hunk =========================== */

export type DiffLine = {
  t: " " | "-" | "+";
  s: string;
  /** 旧文件行号（t 为 "+" 时没有）/ 新文件行号（t 为 "-" 时没有） */
  a?: number;
  b?: number;
  /** 行内变化范围 [start, end)（只对成对的 -/+ 行计算） */
  hl?: [number, number];
};
export type Hunk = { oldStart: number; newStart: number; oldLen: number; newLen: number; lines: DiffLine[] };
export type FileDiff = { change: FileChange; hunks: Hunk[]; added: number; deleted: number };

const splitLines = (s: string | null): string[] => {
  if (s === null || s === "") return [];
  const lines = s.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();   // 文件以换行结尾时，不把末尾的空串当成一行
  return lines;
};

/** 成对的 -/+ 行：去掉公共前后缀，剩下的中间部分就是"这一行里真正变了的地方" */
function markIntraline(lines: DiffLine[]) {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].t !== "-") { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].t === "-") j++;
    let k = j;
    while (k < lines.length && lines[k].t === "+") k++;
    const dels = j - i;
    const adds = k - j;
    const pairs = Math.min(dels, adds);
    for (let p = 0; p < pairs; p++) {
      const d = lines[i + p];
      const a = lines[j + p];
      let pre = 0;
      while (pre < d.s.length && pre < a.s.length && d.s[pre] === a.s[pre]) pre++;
      let suf = 0;
      while (suf < d.s.length - pre && suf < a.s.length - pre && d.s[d.s.length - 1 - suf] === a.s[a.s.length - 1 - suf]) suf++;
      // 整行都不同时加深没有意义（等于没高亮）
      if (pre === 0 && suf === 0) continue;
      d.hl = [pre, d.s.length - suf];
      a.hl = [pre, a.s.length - suf];
    }
    i = k;
  }
}

export function buildFileDiff(change: FileChange, ctxLines = 3): FileDiff {
  if (change.binary) return { change, hunks: [], added: 0, deleted: 0 };
  const a = splitLines(change.before);
  const b = splitLines(change.after);
  const ops = diffOps(a, b);

  let ai = 1;
  let bi = 1;
  const all: DiffLine[] = ops.map((o) => {
    if (o.t === " ") return { t: " ", s: o.s, a: ai++, b: bi++ };
    if (o.t === "-") return { t: "-", s: o.s, a: ai++ };
    return { t: "+", s: o.s, b: bi++ };
  });

  const changedIdx = all.map((l, i) => (l.t === " " ? -1 : i)).filter((i) => i >= 0);
  const added = all.filter((l) => l.t === "+").length;
  const deleted = all.filter((l) => l.t === "-").length;
  if (!changedIdx.length) return { change, hunks: [], added, deleted };

  // 变化行前后各留 ctxLines 行上下文；相邻/重叠的合并成一个 hunk
  const hunks: Hunk[] = [];
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start < 0) return;
    const lines = all.slice(start, end + 1).map((l) => ({ ...l }));
    markIntraline(lines);
    const olds = lines.filter((l) => l.a !== undefined);
    const news = lines.filter((l) => l.b !== undefined);
    hunks.push({
      oldStart: olds[0]?.a ?? (lines.find((l) => l.b !== undefined)?.b ?? 1),
      newStart: news[0]?.b ?? (lines.find((l) => l.a !== undefined)?.a ?? 1),
      oldLen: olds.length,
      newLen: news.length,
      lines,
    });
  };
  for (const idx of changedIdx) {
    const s = Math.max(idx - ctxLines, 0);
    const e = Math.min(idx + ctxLines, all.length - 1);
    if (start >= 0 && s <= end + 1) end = Math.max(end, e);
    else { flush(); start = s; end = e; }
  }
  flush();
  return { change, hunks, added, deleted };
}

export const buildDiffs = (changes: FileChange[]) => changes.map((c) => buildFileDiff(c));

/* =========================== 终端：摘要与高亮 =========================== */

const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  delBg: "\x1b[48;5;52m", delStrong: "\x1b[48;5;124m\x1b[97m",
  addBg: "\x1b[48;5;22m", addStrong: "\x1b[48;5;28m\x1b[97m",
};

const KIND_TAG: Record<FileChange["kind"], string> = { added: "A", modified: "M", deleted: "D" };

/** 任务结束后打印的摘要：每个文件一行 */
export function renderSummary(diffs: FileDiff[], color = useColor()): string {
  if (!diffs.length) return "";
  const c = (code: string, s: string) => (color ? `${code}${s}${C.reset}` : s);
  const rows = diffs.map((d, i) => {
    const stat = d.change.binary ? "(二进制)" : `${c(C.green, `+${d.added}`)} ${c(C.red, `−${d.deleted}`)}`;
    return `  ${String(i + 1).padStart(2)}. ${c(C.yellow, KIND_TAG[d.change.kind])} ${d.change.rel}  ${stat}`;
  });
  const totalA = diffs.reduce((s, d) => s + d.added, 0);
  const totalD = diffs.reduce((s, d) => s + d.deleted, 0);
  return [
    `${c(C.bold, `变更摘要：${diffs.length} 个文件`)}  ${c(C.green, `+${totalA}`)} ${c(C.red, `−${totalD}`)}`,
    ...rows,
    c(C.dim, "  交互查看（并排高亮，n/p 跳转）：/diff   指定文件：/diff <编号|路径>   直接打印：/diff print   其它：/diff vim | html | ide"),
  ].join("\n");
}

/** 一行带底色；hl 范围内用更深的底色（词级高亮） */
function paint(l: DiffLine, color: boolean): string {
  if (!color || l.t === " ") return l.s;
  const base = l.t === "-" ? C.delBg : C.addBg;
  const strong = l.t === "-" ? C.delStrong : C.addStrong;
  if (!l.hl) return `${base}${l.s}${C.reset}`;
  const [s, e] = l.hl;
  return `${base}${l.s.slice(0, s)}${strong}${l.s.slice(s, e)}${C.reset}${base}${l.s.slice(e)}${C.reset}`;
}

const MAX_TERM_LINES = 400;

export function renderFileDiff(d: FileDiff, color = useColor()): string {
  const c = (code: string, s: string) => (color ? `${code}${s}${C.reset}` : s);
  const kind = d.change.kind === "added" ? "新建" : d.change.kind === "deleted" ? "删除" : "修改";
  const head = `${c(C.bold + C.cyan, `── ${d.change.rel}`)}  ${c(C.dim, `[${kind}]`)} ${c(C.green, `+${d.added}`)} ${c(C.red, `−${d.deleted}`)}`;
  if (d.change.binary) return `${head}\n  (二进制文件，不显示内容)`;
  if (!d.hunks.length) return `${head}\n  (内容没有差异)`;

  const width = Math.max(String(Math.max(...d.hunks.flatMap((h) => h.lines.map((l) => l.a ?? l.b ?? 0)), 1)).length, 3);
  const out: string[] = [head];
  let shown = 0;
  for (const h of d.hunks) {
    out.push(c(C.dim, `  @@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@`));
    for (const l of h.lines) {
      if (shown >= MAX_TERM_LINES) { out.push(c(C.dim, `  …（过长已截断；用 /diff html 查看完整内容）`)); return out.join("\n"); }
      const a = l.a !== undefined ? String(l.a).padStart(width) : " ".repeat(width);
      const b = l.b !== undefined ? String(l.b).padStart(width) : " ".repeat(width);
      const sign = l.t === " " ? " " : l.t;
      out.push(`${c(C.dim, `${a} ${b}`)} ${l.t === " " ? " " : c(l.t === "-" ? C.red : C.green, sign)} ${paint(l, color)}`);
      shown++;
    }
  }
  return out.join("\n");
}

/** /diff 的选择器：编号 / 相对路径（后缀匹配）/ all */
export function pickDiffs(diffs: FileDiff[], sel: string): FileDiff[] | string {
  const s = sel.trim();
  if (!s || s === "all") return diffs;
  if (/^\d+$/.test(s)) {
    const d = diffs[parseInt(s, 10) - 1];
    return d ? [d] : `没有编号 ${s}（共 ${diffs.length} 个文件）`;
  }
  const norm = s.replace(/\\/g, "/");
  const hit = diffs.filter((d) => d.change.rel === norm || d.change.rel.endsWith("/" + norm) || d.change.rel.includes(norm));
  return hit.length ? hit : `没有匹配 "${s}" 的改动文件`;
}

/* =========================== HTML：可点击展开的高亮视图 =========================== */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function htmlLine(l: DiffLine): string {
  let body: string;
  if (l.hl) {
    const [s, e] = l.hl;
    body = `${esc(l.s.slice(0, s))}<mark>${esc(l.s.slice(s, e))}</mark>${esc(l.s.slice(e))}`;
  } else body = esc(l.s);
  const cls = l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx";
  return `<tr class="${cls}"><td class="n">${l.a ?? ""}</td><td class="n">${l.b ?? ""}</td><td class="s">${l.t === " " ? "&nbsp;" : l.t}</td><td class="c">${body || "&nbsp;"}</td></tr>`;
}

export function renderHtml(diffs: FileDiff[], title: string): string {
  const totalA = diffs.reduce((s, d) => s + d.added, 0);
  const totalD = diffs.reduce((s, d) => s + d.deleted, 0);
  const sections = diffs.map((d, i) => {
    const kind = d.change.kind === "added" ? "新建" : d.change.kind === "deleted" ? "删除" : "修改";
    const body = d.change.binary
      ? `<div class="note">二进制文件，不显示内容</div>`
      : d.hunks.length
        ? d.hunks.map((h) => `<div class="hunk">@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@</div><table>${h.lines.map(htmlLine).join("")}</table>`).join("")
        : `<div class="note">内容没有差异</div>`;
    return `<details${diffs.length === 1 ? " open" : ""}><summary><span class="k k-${d.change.kind}">${kind}</span> <b>${esc(d.change.rel)}</b> <span class="a">+${d.added}</span> <span class="d">−${d.deleted}</span></summary>${body}</details>`;
  });
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:0;background:#1e1e1e;color:#d4d4d4}
header{position:sticky;top:0;background:#252526;padding:10px 16px;border-bottom:1px solid #3c3c3c;display:flex;gap:12px;align-items:center}
header button{background:#0e639c;color:#fff;border:0;padding:4px 10px;border-radius:3px;cursor:pointer}
main{padding:12px 16px}
details{margin:8px 0;border:1px solid #3c3c3c;border-radius:4px;background:#1e1e1e}
summary{cursor:pointer;padding:8px 12px;background:#2d2d30;user-select:none}
summary:hover{background:#37373d}
.a{color:#4ec9b0}.d{color:#f48771}
.k{font-size:12px;padding:1px 6px;border-radius:3px;background:#444}.k-added{background:#1d5f3a}.k-deleted{background:#7a2323}.k-modified{background:#5a4a12}
.hunk{padding:2px 12px;background:#26303a;color:#8aa4bf;font:12px Consolas,monospace}
table{border-collapse:collapse;width:100%;font:13px/1.45 Consolas,Menlo,monospace}
td{padding:0 6px;vertical-align:top;white-space:pre-wrap;word-break:break-all}
td.n{width:1%;text-align:right;color:#6e7681;user-select:none;white-space:nowrap}
td.s{width:1%;user-select:none}
tr.add{background:rgba(46,160,67,.18)}tr.add td.s{color:#4ec9b0}tr.add mark{background:rgba(46,160,67,.55);color:inherit}
tr.del{background:rgba(248,81,73,.18)}tr.del td.s{color:#f48771}tr.del mark{background:rgba(248,81,73,.55);color:inherit}
.note{padding:10px 12px;color:#888}
</style></head><body>
<header><b>${esc(title)}</b><span>${diffs.length} 个文件</span><span class="a">+${totalA}</span><span class="d">−${totalD}</span>
<button onclick="document.querySelectorAll('details').forEach(d=>d.open=true)">全部展开</button>
<button onclick="document.querySelectorAll('details').forEach(d=>d.open=false)">全部折叠</button></header>
<main>${sections.join("\n")}</main></body></html>`;
}

/* =========================== 打开外部查看器 =========================== */

/** 尽力打开文件/网页；失败（无图形界面、远程服务器）返回 false，调用方打印路径让用户自己打开 */
export function openExternal(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", '""', `"${target}"`] : [target];
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return resolve(false);
    try {
      const p = spawn(cmd, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: process.platform === "win32" });
      p.on("error", () => resolve(false));
      p.on("spawn", () => { p.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

export async function writeHtml(root: string, diffs: FileDiff[]): Promise<string> {
  const dir = path.join(root, ".agent");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "diff.html");
  await fs.writeFile(file, renderHtml(diffs, `Mini Agent 变更 — ${path.basename(root)}`), "utf8");
  return file;
}

/** 把"改动前"内容写到临时文件，返回 { orig（改动前）, cur（当前文件；被删除的文件用空文件代替） } 供外部 diff 工具使用 */
export async function prepareCompare(sessionId: string, d: FileDiff): Promise<{ orig: string; cur: string }> {
  const dir = path.join(os.tmpdir(), "mini-agent-diff", sessionId);
  const orig = path.join(dir, d.change.rel);
  await fs.mkdir(path.dirname(orig), { recursive: true });
  await fs.writeFile(orig, d.change.before ?? "", "utf8");
  if (d.change.kind !== "deleted") return { orig, cur: d.change.abs };
  const cur = orig + ".deleted";
  await fs.writeFile(cur, "", "utf8");
  return { orig, cur };
}

/** 用 Cursor / VS Code 的 diff 编辑器打开：左边是改动前（临时文件），右边是当前文件 */
export async function openInIde(sessionId: string, diffs: FileDiff[]): Promise<{ ok: boolean; tool?: string; note: string }> {
  const targets = diffs.filter((d) => !d.change.binary);
  if (!targets.length) return { ok: false, note: "没有可对比的文本文件。" };

  for (const tool of ["cursor", "code"]) {
    let launched = false;
    for (const d of targets) {
      const { orig, cur } = await prepareCompare(sessionId, d);
      const ok = await new Promise<boolean>((resolve) => {
        try {
          const win = process.platform === "win32";    // shell 模式下参数不会自动加引号，路径里常有空格
          const q = (s: string) => (win ? `"${s}"` : s);
          const p = spawn(tool, ["--diff", q(orig), q(cur)], { detached: true, stdio: "ignore", shell: win });
          p.on("error", () => resolve(false));
          p.on("spawn", () => { p.unref(); resolve(true); });
        } catch { resolve(false); }
      });
      if (!ok) break;
      launched = true;
    }
    if (launched) return { ok: true, tool, note: `已用 ${tool} 打开 ${targets.length} 个 diff 对比。` };
  }
  return { ok: false, note: "找不到 `cursor` / `code` 命令（需要在编辑器里执行 “Install 'cursor' command in PATH”）。可改用 /diff html。" };
}
