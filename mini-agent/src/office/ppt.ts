import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPT_ENABLED } from "../config.js";

/**
 * PowerPoint 原生控制：通过一个常驻的 PowerShell 进程（ppt-bridge.ps1）走 COM 自动化。
 * 为什么是常驻进程：每次调用都重新起 PowerShell + 连接 COM 要 1~2 秒；常驻后一次调用通常只要几十毫秒。
 * 协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应（见 ppt-bridge.ps1 开头）。
 * 只在 Windows 且装了桌面版 PowerPoint 时可用（见 pptAvailable）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 编译后（dist/）脚本不会被 tsc 复制，所以始终从源码目录读取；tsx 开发时两者相同 */
const EXE_DIR = path.dirname(process.execPath);   // bun --compile 单文件时，脚本放在可执行文件旁边
const SCRIPT = [
  path.join(HERE, "ppt-bridge.ps1"),
  path.join(HERE, "..", "..", "src", "office", "ppt-bridge.ps1"),
  path.join(EXE_DIR, "ppt-bridge.ps1"),
  path.join(EXE_DIR, "src", "office", "ppt-bridge.ps1"),
].find((p) => fs.existsSync(p)) ?? path.join(HERE, "ppt-bridge.ps1");

let availability: boolean | null = null;
/** Windows + 桌面版 PowerPoint（注册表里有 PowerPoint.Application）。AGENT_PPT=0 强制关闭，AGENT_PPT=1 强制开启 */
export function pptAvailable(): boolean {
  if (PPT_ENABLED === "0") return false;
  if (PPT_ENABLED === "1") return process.platform === "win32";
  if (availability !== null) return availability;
  if (process.platform !== "win32") return (availability = false);
  try {
    execFileSync("reg", ["query", "HKCR\\PowerPoint.Application", "/ve"], { stdio: "ignore", timeout: 3000, windowsHide: true });
    availability = true;
  } catch { availability = false; }
  return availability;
}

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

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class PptBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, Pending>();
  private starting: Promise<void> | null = null;
  /** 本会话里已经为哪些演示文稿做过备份（第一次编辑前备份一次） */
  readonly backedUp = new Set<string>();

  private start(): Promise<void> {
    if (this.proc && !this.proc.killed) return this.starting ?? Promise.resolve();
    this.buf = "";
    const proc = spawn("powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.stdout.setEncoding("utf8");
    this.starting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`PowerPoint 桥接进程启动超时${stderr ? `：${stderr.slice(0, 300)}` : ""}`)), 20_000);
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
        const err = new Error(`PowerPoint 桥接进程已退出（code ${code}）${stderr ? `：${stderr.slice(0, 300)}` : ""}（如提示执行策略被组策略禁止，请联系管理员或设置 AGENT_PPT=0 关闭该功能）`);
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
  dump(slide?: number, theme = false) { return this.call<PptSlide>("dump", { slide, theme }); }
  titles() { return this.call<{ slides: Array<{ index: number; title: string; shapes: number }> }>("titles"); }
  fingerprint() { return this.call<{ running: boolean; open?: boolean; fp?: string; slide?: number }>("fingerprint", {}, 10_000); }
  exportSlide(slide: number | undefined, file: string, width = 1280) { return this.call<{ path: string }>("export", { slide, path: file, width }, 60_000); }
  /** reveal=true（默认）：改完后让 PowerPoint 窗口跳到被改动的那一页，用户能直接看到变化 */
  edit(ops: unknown[], reveal = true) { return this.call<EditResult>("edit", { ops, reveal }, 60_000); }
  backup(file: string) { return this.call<{ path: string }>("backup", { path: file }, 60_000); }
  save(file?: string) { return this.call<{ saved: string }>("save", file ? { path: file } : {}, 60_000); }
  open(file: string) { return this.call<{ opened: string }>("open", { path: file }, 60_000); }
  newPresentation() { return this.call<{ name: string }>("new", {}, 60_000); }

  dispose() {
    const p = this.proc;
    this.proc = null; this.starting = null;
    for (const [, x] of this.pending) { clearTimeout(x.timer); x.reject(new Error("PowerPoint 桥接已关闭")); }
    this.pending.clear();
    if (p && !p.killed) { try { p.stdin.end(); } catch { /* ignore */ } setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 500).unref?.(); }
  }
}
