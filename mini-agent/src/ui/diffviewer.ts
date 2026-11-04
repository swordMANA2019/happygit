import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import { prepareCompare, renderFileDiff, type DiffLine, type FileDiff } from "./diffview.js";

/**
 * 内置的交互式 diff 查看器：纯 Node 实现，不依赖 vim / 浏览器 / IDE，Windows / macOS / Linux 终端都能用。
 *   文件列表 ↑↓ 选择，Enter 进入 → 左右并排（旧 | 新）高亮视图，n / p 在改动块之间跳转。
 * 用备用屏幕缓冲区（和 vim / less 一样），退出后终端原样恢复。
 */

const ESC = "\x1b[";
const S = {
  reset: `${ESC}0m`, dim: `${ESC}2m`, bold: `${ESC}1m`, rev: `${ESC}7m`,
  cyan: `${ESC}36m`, green: `${ESC}32m`, red: `${ESC}31m`, yellow: `${ESC}33m`, gray: `${ESC}90m`,
  delBg: `${ESC}48;5;52m`, delStrong: `${ESC}48;5;124m${ESC}97m`,
  addBg: `${ESC}48;5;22m`, addStrong: `${ESC}48;5;28m${ESC}97m`,
};

/* ---------------- 宽度与单元格 ---------------- */

const isWide = (cp: number) =>
  cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd));

/** 可见宽度（中日韩全角字符占 2 列；不含 ANSI 序列的纯文本） */
export function visWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return w;
}

/** 展开 tab（4 列对齐），同时把行内高亮范围换算到展开后的下标 */
function expandTabs(s: string, hl?: [number, number]): { s: string; hl?: [number, number] } {
  if (!s.includes("\t")) return { s, hl };
  let out = "";
  let col = 0;
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    map[i] = out.length;
    if (s[i] === "\t") { const n = 4 - (col % 4); out += " ".repeat(n); col += n; }
    else { out += s[i]; col += isWide(s.codePointAt(i)!) ? 2 : 1; }
  }
  map[s.length] = out.length;
  return { s: out, hl: hl ? [map[hl[0]], map[hl[1]]] : undefined };
}

/** 渲染一个固定宽度的单元格：超长截断为 …，不足补空格（底色铺满整格，视觉上才是"整行高亮"） */
function cell(text: string, hl: [number, number] | undefined, width: number, kind: " " | "-" | "+"): string {
  const { s, hl: h } = expandTabs(text, hl);
  const base = kind === "-" ? S.delBg : kind === "+" ? S.addBg : "";
  const strong = kind === "-" ? S.delStrong : kind === "+" ? S.addStrong : "";

  const total = visWidth(s);
  const limit = total > width ? width - 1 : width;
  let out = "";
  let w = 0;
  let inStrong = false;
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = isWide(cp) ? 2 : 1;
    if (w + cw > limit) break;
    const wantStrong = !!h && i >= h[0] && i < h[1];
    if (wantStrong !== inStrong) { out += wantStrong ? strong : `${S.reset}${base}`; inStrong = wantStrong; }
    out += ch;
    w += cw;
    i += ch.length;
  }
  if (inStrong) out += `${S.reset}${base}`;
  if (total > width) { out += "…"; w += 1; }
  out += " ".repeat(Math.max(width - w, 0));
  return base ? `${base}${out}${S.reset}` : out;
}

/* ---------------- 版面：把一个文件的 hunks 排成屏幕行 ---------------- */

type Layout = { lines: string[]; hunkRows: number[] };

type Row = { l?: DiffLine; r?: DiffLine };

/** 并排：连续的 - 和 + 逐行配对，多出来的一侧留空 */
function pairRows(lines: DiffLine[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].t === " ") { rows.push({ l: lines[i], r: lines[i] }); i++; continue; }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].t === "-") dels.push(lines[i++]);
    while (i < lines.length && lines[i].t === "+") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ l: dels[k], r: adds[k] });
  }
  return rows;
}

export function layoutFile(d: FileDiff, split: boolean, cols: number): Layout {
  const lines: string[] = [];
  const hunkRows: number[] = [];
  const kind = d.change.kind === "added" ? "新建" : d.change.kind === "deleted" ? "删除" : "修改";
  lines.push(`${S.bold}${S.cyan}${d.change.rel}${S.reset} ${S.dim}[${kind}]${S.reset} ${S.green}+${d.added}${S.reset} ${S.red}−${d.deleted}${S.reset}`);

  if (d.change.binary) { lines.push(`${S.dim}(二进制文件，不显示内容)${S.reset}`); return { lines, hunkRows }; }
  if (!d.hunks.length) { lines.push(`${S.dim}(内容没有差异)${S.reset}`); return { lines, hunkRows }; }

  const maxNo = Math.max(...d.hunks.flatMap((h) => h.lines.map((l) => l.a ?? l.b ?? 0)), 1);
  const nw = Math.max(String(maxNo).length, 3);
  const num = (n?: number) => `${S.gray}${n === undefined ? " ".repeat(nw) : String(n).padStart(nw)}${S.reset}`;

  const useSplit = split && cols >= 70;
  const sw = Math.floor((cols - 2 * nw - 5) / 2);           // 并排：每侧代码区宽度
  const uw = Math.max(cols - 2 * nw - 4, 10);                // 统一视图：代码区宽度

  for (const h of d.hunks) {
    hunkRows.push(lines.length);
    lines.push(`${S.dim}${S.cyan}⋯ @@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@${S.reset}`);
    if (useSplit) {
      for (const row of pairRows(h.lines)) {
        const L = row.l ? cell(row.l.s, row.l.hl, sw, row.l.t === "-" ? "-" : " ") : " ".repeat(sw);
        const R = row.r ? cell(row.r.s, row.r.hl, sw, row.r.t === "+" ? "+" : " ") : " ".repeat(sw);
        lines.push(`${num(row.l?.a)} ${L} ${S.gray}│${S.reset} ${num(row.r?.b)} ${R}`);
      }
    } else {
      for (const l of h.lines) {
        const sign = l.t === " " ? " " : l.t === "-" ? `${S.red}-${S.reset}` : `${S.green}+${S.reset}`;
        lines.push(`${num(l.a)} ${num(l.b)} ${sign}${cell(l.s, l.hl, uw, l.t)}`);
      }
    }
  }
  return { lines, hunkRows };
}

/* ---------------- 查看器 ---------------- */

const KIND_TAG = { added: "A", modified: "M", deleted: "D" } as const;

/** 状态栏：反色，按可见宽度补齐 */
function statusBar(text: string, cols: number): string {
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = isWide(ch.codePointAt(0)!) ? 2 : 1;
    if (w + cw > cols) break;
    out += ch;
    w += cw;
  }
  return `${S.rev}${out}${" ".repeat(Math.max(cols - w, 0))}${S.reset}`;
}

/**
 * 打开交互式查看器；用户按 q 退出后才 resolve。
 * 非交互终端（管道/重定向）退化为直接打印。
 */
export async function runDiffViewer(diffs: FileDiff[], openIndex?: number): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    for (const d of diffs) console.log(`\n${renderFileDiff(d)}`);
    return;
  }

  // readline 接口也在监听同一个 stdin：先摘掉它的 keypress 监听，退出时原样装回，两者不会抢键
  const saved = stdin.listeners("keypress") as Array<(...a: any[]) => void>;
  stdin.removeAllListeners("keypress");
  const wasRaw = stdin.isRaw;
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(`${ESC}?1049h${ESC}?25l`);

  let mode: "list" | "file" = openIndex !== undefined || diffs.length === 1 ? "file" : "list";
  let sel = openIndex ?? 0;
  let top = 0;
  let split = true;
  let cache: { key: string; layout: Layout } | null = null;

  const size = () => ({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
  const layoutOf = (cols: number): Layout => {
    const key = `${sel}|${split}|${cols}`;
    if (cache?.key !== key) cache = { key, layout: layoutFile(diffs[sel], split, cols) };
    return cache.layout;
  };

  const draw = () => {
    const { rows, cols } = size();
    const h = Math.max(rows - 1, 1);
    let body: string[];
    let status: string;

    if (mode === "list") {
      const head = `${S.bold}变更文件（${diffs.length}）${S.reset}`;
      const items = diffs.map((d, i) => {
        const stat = d.change.binary ? "(二进制)" : `${S.green}+${d.added}${S.reset} ${S.red}−${d.deleted}${S.reset}`;
        const line = `${S.yellow}${KIND_TAG[d.change.kind]}${S.reset} ${d.change.rel}  ${stat}`;
        return i === sel ? `${S.rev} ▶ ${S.reset} ${S.bold}${line}${S.reset}` : `    ${line}`;
      });
      const winTop = Math.max(0, Math.min(sel - Math.floor((h - 2) / 2), items.length - (h - 2)));
      body = [head, "", ...items.slice(winTop, winTop + h - 2)];
      status = " ↑↓/jk 选择   Enter 打开   q 退出";
    } else {
      const lay = layoutOf(cols);
      top = Math.max(0, Math.min(top, Math.max(lay.lines.length - h, 0)));
      body = lay.lines.slice(top, top + h);
      const pct = lay.lines.length <= h ? 100 : Math.round(((top + h) / lay.lines.length) * 100);
      const hunkNo = lay.hunkRows.filter((r) => r <= top + 1).length;
      status = ` ${diffs[sel].change.rel}  [${sel + 1}/${diffs.length}]  块 ${Math.max(hunkNo, lay.hunkRows.length ? 1 : 0)}/${lay.hunkRows.length}  ${pct}%` +
        `   ↑↓/jk 滚动  n/p 下/上一块  ←→ 切换文件  u ${split ? "统一" : "并排"}视图  ${diffs.length > 1 ? "Esc 列表  " : ""}q 退出`;
    }

    let out = `${ESC}H`;
    for (let i = 0; i < h; i++) out += `${body[i] ?? ""}${ESC}K${i < h - 1 ? "\r\n" : ""}`;
    out += `${ESC}${rows};1H${statusBar(status, cols)}`;
    stdout.write(out);
  };

  return new Promise<void>((resolve) => {
    const finish = () => {
      stdin.off("keypress", onKey);
      stdout.off("resize", draw);
      stdout.write(`${ESC}?25h${ESC}?1049l`);
      for (const l of saved) stdin.on("keypress", l);
      try { stdin.setRawMode(wasRaw ?? true); } catch { /* 终端已关闭 */ }
      resolve();
    };

    const openFile = (i: number) => { sel = (i + diffs.length) % diffs.length; top = 0; mode = "file"; };

    const onKey = (_s: string, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined) => {
      const k = key?.name ?? key?.sequence ?? "";
      if (key?.ctrl && k === "c") return finish();
      if (k === "q") return finish();

      const { rows, cols } = size();
      const h = Math.max(rows - 1, 1);

      if (mode === "list") {
        if (k === "down" || k === "j") sel = Math.min(sel + 1, diffs.length - 1);
        else if (k === "up" || k === "k") sel = Math.max(sel - 1, 0);
        else if (k === "home" || k === "g") sel = 0;
        else if (k === "end") sel = diffs.length - 1;
        else if (k === "return" || k === "right" || k === "l") openFile(sel);
      } else {
        const lay = layoutOf(cols);
        const max = Math.max(lay.lines.length - h, 0);
        if (k === "down" || k === "j" || k === "return") top = Math.min(top + 1, max);
        else if (k === "up" || k === "k") top = Math.max(top - 1, 0);
        else if (k === "pagedown" || k === "space" || k === "f") top = Math.min(top + h - 1, max);
        else if (k === "pageup" || k === "b") top = Math.max(top - (h - 1), 0);
        else if (k === "home" || k === "g") top = 0;
        else if (k === "end" || k === "G") top = max;
        else if (k === "n") top = Math.min(lay.hunkRows.find((r) => r > Math.max(top, 1)) ?? top, max);   // 第一块一开始就在屏幕上，所以从顶部按 n 直接去第二块
        else if (k === "p") top = [...lay.hunkRows].reverse().find((r) => r < top) ?? 0;
        else if (k === "right" || k === "l" || k === "tab" || k === "]") openFile(sel + 1);
        else if (k === "left" || k === "h" || k === "[") openFile(sel - 1);
        else if (k === "u" || k === "s") { split = !split; cache = null; }
        else if ((k === "escape" || k === "backspace") && diffs.length > 1) mode = "list";
        else if (k === "escape") return finish();
      }
      draw();
    };

    stdin.on("keypress", onKey);
    stdout.on("resize", draw);
    draw();
  });
}

/* ---------------- 可选：vim 对比（有 vim 才用；没有就用内置查看器） ---------------- */

function findVim(): { cmd: string; args: (a: string, b: string) => string[] } | null {
  const candidates: Array<{ cmd: string; args: (a: string, b: string) => string[] }> = [
    { cmd: "nvim", args: (a, b) => ["-d", a, b] },
    { cmd: "vim", args: (a, b) => ["-d", a, b] },
    { cmd: "vimdiff", args: (a, b) => [a, b] },
  ];
  if (process.platform === "win32") {
    // Windows 默认没有 vim，但 Git for Windows 自带一个
    for (const dir of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LOCALAPPDATA"] && `${process.env["LOCALAPPDATA"]}\\Programs`]) {
      if (dir) candidates.push({ cmd: `${dir}\\Git\\usr\\bin\\vim.exe`, args: (a, b) => ["-d", a, b] });
    }
  }
  for (const c of candidates) {
    const r = spawnSync(c.cmd, ["--version"], { stdio: "ignore" });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

/**
 * 逐个文件用 vim -d（左：改动前，右：当前）打开；退出 vim 后继续下一个。
 * 找不到 vim 返回 false，由调用方回退到内置查看器。
 */
export async function openInVim(sessionId: string, diffs: FileDiff[]): Promise<boolean> {
  const vim = findVim();
  if (!vim) return false;
  const targets = diffs.filter((d) => !d.change.binary);

  // 把终端交给 vim：摘掉 readline 的监听、退出 raw 模式，vim 结束后再接管回来
  const saved = stdin.listeners("keypress") as Array<(...a: any[]) => void>;
  stdin.removeAllListeners("keypress");
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
  try {
    for (const d of targets) {
      const { orig, cur } = await prepareCompare(sessionId, d);
      await new Promise<void>((resolve) => {
        const p = spawn(vim.cmd, vim.args(orig, cur), { stdio: "inherit" });
        p.on("error", () => resolve());
        p.on("exit", () => resolve());
      });
    }
  } finally {
    for (const l of saved) stdin.on("keypress", l);
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? true);
    stdin.resume();
  }
  return true;
}
