import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PowerPoint 原生控制：通过一个常驻的 PowerShell 进程（ppt-bridge.ps1）走 COM 自动化。
 * 为什么是常驻进程：每次调用都重新起 PowerShell + 连接 COM 要 1~2 秒；常驻后一次调用通常只要几十毫秒。
 * 协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应（见 ppt-bridge.ps1 开头）。
 * 只在 Windows 且装了桌面版 PowerPoint 时可用（见 pptAvailable）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 找到 ppt-bridge.ps1：包根目录（dist/ 的上一级）→ 同目录 → 可执行文件旁边（bun --compile 单文件时） */
export function findBridgeScript(): string {
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(HERE, "..", "ppt-bridge.ps1"),
    path.join(HERE, "ppt-bridge.ps1"),
    path.join(exeDir, "ppt-bridge.ps1"),
    path.join(exeDir, "packages", "ppt-sdk", "ppt-bridge.ps1"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

let detected: boolean | null = null;
/**
 * Windows + 桌面版 PowerPoint（注册表里有 PowerPoint.Application）。
 * force=false 强制关闭；force=true 在 Windows 上强制开启（跳过检测）；不传 = 自动检测（结果缓存）。
 * SDK 本身不读任何环境变量，开关由使用方决定。
 */
export function pptAvailable(force?: boolean): boolean {
  if (force === false) return false;
  if (force === true) return process.platform === "win32";
  if (detected !== null) return detected;
  if (process.platform !== "win32") return (detected = false);
  try {
    execFileSync("reg", ["query", "HKCR\\PowerPoint.Application", "/ve"], { stdio: "ignore", timeout: 3000, windowsHide: true });
    detected = true;
  } catch { detected = false; }
  return detected;
}

let warming: Promise<boolean> | null = null;
/**
 * 后台检测（不阻塞事件循环）：启动时先调用它，pptAvailable() 之后直接命中缓存。
 * 同步版 pptAvailable() 要起一个 reg.exe 进程并等它退出（冷启动约 100–200ms），放在启动路径上会拖慢窗口出现。
 */
export function warmPptDetection(): Promise<boolean> {
  if (detected !== null) return Promise.resolve(detected);
  if (process.platform !== "win32") return Promise.resolve((detected = false));
  return (warming ??= new Promise<boolean>((resolve) => {
    execFile("reg", ["query", "HKCR\\PowerPoint.Application", "/ve"], { timeout: 3000, windowsHide: true }, (err) => {
      detected ??= !err;
      resolve(detected);
    });
  }));
}
/** 已检测过就返回结果，否则 null（不触发检测） */
export const pptDetected = (): boolean | null => detected;

/* ---------- 数据类型（对应 ppt-bridge.ps1 的 dump / state 输出） ---------- */

export type PptShape = {
  id: number; name: string; kind: string; left: number; top: number; width: number; height: number;
  rotation: number; z: number; visible: boolean;
  placeholder?: number; children?: number; alt?: string; autosize?: number;
  text?: string; paragraphs?: number; font?: string; size?: number; bold?: boolean; color?: string;
  textWidth?: number; textHeight?: number; marginL?: number; marginT?: number;
  fill?: string; line?: string; lineWidth?: number;
};
export type PptSlide = {
  index: number; layout: string; shapes: PptShape[]; background?: string; followMasterBackground?: boolean; notes?: string;
  slideWidth: number; slideHeight: number; slideCount: number;
  theme?: { colors?: Record<string, string>; majorFont?: string; minorFont?: string };
};
export type PptState = {
  running: boolean; presentations?: Array<{ name: string; path: string; saved: boolean; slides: number }>;
  active?: string; path?: string; saved?: boolean; slideCount?: number; slideWidth?: number; slideHeight?: number; activeSlide?: number;
  selection?: { type: "none" | "slides" | "shapes" | "text"; slides?: number[]; shapes?: Array<{ id: number; name: string }>; text?: string };
};
export type EditResult = { ok: boolean; applied: string[]; failedAt?: number; error?: string; shown?: number };
export type PptFingerprint = { running: boolean; open?: boolean; fp?: string; slide?: number };

/**
 * 工具处理函数、watcher 依赖的最小接口。PptBridge 实现它；单元测试可以用假对象代替（不需要装 PowerPoint）。
 */
export interface PptApi {
  /** 本会话已经备份过的文稿（第一次编辑前备份一次） */
  readonly backedUp: Set<string>;
  state(): Promise<PptState>;
  dump(slide?: number, theme?: boolean): Promise<PptSlide>;
  titles(): Promise<{ slides: Array<{ index: number; title: string; shapes: number }> }>;
  fingerprint(): Promise<PptFingerprint>;
  exportSlide(slide: number | undefined, file: string, width?: number): Promise<{ path: string }>;
  edit(ops: unknown[], reveal?: boolean): Promise<EditResult>;
  backup(file: string): Promise<{ path: string }>;
  open(file: string): Promise<{ opened: string }>;
  newPresentation(): Promise<{ name: string }>;
  save(file?: string): Promise<{ saved: string }>;
}

export type PptBridgeOptions = {
  /** ppt-bridge.ps1 的路径；默认自动查找 */
  scriptPath?: string;
  /** 启动超时（默认 20s） */
  startTimeoutMs?: number;
};

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class PptBridge implements PptApi {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, Pending>();
  private starting: Promise<void> | null = null;
  private readonly script: string;
  private readonly startTimeout: number;
  readonly backedUp = new Set<string>();

  constructor(opts: PptBridgeOptions = {}) {
    this.script = opts.scriptPath ?? findBridgeScript();
    this.startTimeout = opts.startTimeoutMs ?? 20_000;
  }

  private start(): Promise<void> {
    if (this.proc && !this.proc.killed) return this.starting ?? Promise.resolve();
    this.buf = "";
    const proc = spawn("powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", this.script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.stdout.setEncoding("utf8");
    this.starting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`PowerPoint 桥接进程启动超时${stderr ? `：${stderr.slice(0, 300)}` : ""}`)), this.startTimeout);
      proc.stdout.on("data", (chunk: string) => {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }       // 非协议输出（理论上不会有）直接忽略
          if (msg.ready) { clearTimeout(timer); resolve(); continue; }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.data); else p.reject(new Error(String(msg.error ?? "未知错误")));
        }
      });
      proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`无法启动 powershell.exe：${e.message}`)); });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        const err = new Error(`PowerPoint 桥接进程已退出（code ${code}）${stderr ? `：${stderr.slice(0, 300)}` : ""}（如提示执行策略被组策略禁止，请联系管理员）`);
        reject(err);
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
        if (this.proc === proc) { this.proc = null; this.starting = null; }
      });
    });
    return this.starting;
  }

  /** 发一条命令并等响应；超时会杀掉桥接进程（下次调用自动重启） */
  async call<T = any>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new Error("PowerPoint 桥接进程不可用");
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PowerPoint 操作超时（${timeoutMs / 1000}s）：${cmd}。可能弹出了对话框或 PowerPoint 无响应；已重置桥接进程`));
        this.dispose();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, cmd, args }) + "\n", "utf8");
    });
  }

  state() { return this.call<PptState>("state"); }
  /**
   * 后台预热：先把 PowerShell 进程拉起来、连上 PowerPoint，并读一遍当前页（丢弃结果，不缓存，所以不会有过期数据）。
   * 冷启动约 1.7s（进程 0.8s + 首次 COM 连接 0.45s + 首次读形状 0.5s）；在模型还在思考的时候做掉，
   * 第一次真正的工具调用就不用再付。从不抛错；没开 PowerPoint / 没打开文稿时什么也不做。
   */
  async prewarm(): Promise<void> {
    try {
      const st = await this.state();
      if (st.running && st.active) await this.dump(undefined, true);
    } catch { /* 预热失败不影响任何事：真正调用时会再报 */ }
  }
  dump(slide?: number, theme = false) { return this.call<PptSlide>("dump", { slide, theme }); }
  titles() { return this.call<{ slides: Array<{ index: number; title: string; shapes: number }> }>("titles"); }
  fingerprint() { return this.call<PptFingerprint>("fingerprint", {}, 10_000); }
  exportSlide(slide: number | undefined, file: string, width = 1280) { return this.call<{ path: string }>("export", { slide, path: file, width }, 60_000); }
  /** reveal=true（默认）：改完后让 PowerPoint 窗口跳到被改动的那一页，用户能直接看到变化 */
  edit(ops: unknown[], reveal = true) { return this.call<EditResult>("edit", { ops, reveal }, 60_000); }
  backup(file: string) { return this.call<{ path: string }>("backup", { path: file }, 60_000); }
  save(file?: string) { return this.call<{ saved: string }>("save", file ? { path: file } : {}, 60_000); }
  open(file: string) { return this.call<{ opened: string }>("open", { path: file }, 60_000); }
  newPresentation() { return this.call<{ name: string }>("new", {}, 60_000); }
  /** 关闭当前活动文稿（不保存）。主要给测试清理用 */
  closeActive() { return this.call<{ closed: string }>("close", {}, 30_000); }

  dispose() {
    const p = this.proc;
    this.proc = null; this.starting = null;
    for (const [, x] of this.pending) { clearTimeout(x.timer); x.reject(new Error("PowerPoint 桥接已关闭")); }
    this.pending.clear();
    if (p && !p.killed) { try { p.stdin.end(); } catch { /* ignore */ } setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 500).unref?.(); }
  }
}
