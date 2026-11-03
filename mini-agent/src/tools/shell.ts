import { spawn } from "node:child_process";
import { classifyFailure, type FailureKind } from "../errors.js";
import { stripAnsi, truncateMiddle } from "../util.js";

export type ExecResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  durationMs: number;
  /** 仅 ok=false 时有意义 */
  kind: FailureKind | "ok";
  reason: string;
};

export type ExecOpts = {
  cwd?: string;
  timeoutMs?: number;
  /** 单路输出最多保留多少字符（超出部分丢弃，避免撑爆内存） */
  maxChars?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
};

/**
 * 子进程输出解码。中文 Windows 的 cmd.exe / 系统工具输出是 GBK（代码页 936），
 * 按 UTF-8 解会变成乱码，"不是内部或外部命令"之类的环境错误特征就匹配不上。
 * 先严格按 UTF-8 解；不合法再回退 GBK（仅 Windows）。
 */
export function decodeOutput(chunks: Buffer[]): string {
  const buf = Buffer.concat(chunks);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    if (process.platform === "win32") {
      try { return new TextDecoder("gbk").decode(buf); } catch { /* ICU 不支持 gbk */ }
    }
    return buf.toString("utf8");
  }
}

export function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // exec 的 timeout 只会杀 cmd.exe，子进程（node/tsc/pytest）会变成孤儿继续跑
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL"); // 杀整个进程组
    }
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
}

/**
 * 统一的命令执行入口：永不抛异常，所有失败都以结构化结果返回。
 *   - stdin 关闭：避免 npm init / 交互式提示把 Agent 永远卡住
 *   - 超时/中断：杀掉整个进程树
 *   - 启动失败（cwd 不存在、shell 缺失）：spawnError，而不是抛出
 */
export function execCommand(command: string, opts: ExecOpts = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxChars = opts.maxChars ?? 2_000_000;
  const started = Date.now();

  return new Promise<ExecResult>((resolve) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let spawnError: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;

    function onAbort() { spawnError = "已被用户中断"; killTree(child?.pid); }

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      stdout = decodeOutput(outChunks);
      stderr = decodeOutput(errChunks) + stderr; // stderr 里可能已有 spawn 失败信息
      const raw = { code, stdout, stderr, timedOut, spawnError };
      const ok = code === 0 && !timedOut && !spawnError;
      const f = ok ? { kind: "ok" as const, reason: "" } : classifyFailure(raw);
      resolve({ ok, ...raw, durationMs: Date.now() - started, kind: f.kind, reason: f.reason });
    };

    try {
      child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0", ...opts.env },
      });
    } catch (e: any) {
      spawnError = e?.message ?? String(e);
      stderr = spawnError!;
      finish(null);
      return;
    }

    const proc = child;
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    timer = setTimeout(() => { timedOut = true; killTree(proc.pid); }, timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => { if (outBytes < maxChars) { outChunks.push(d); outBytes += d.length; } });
    proc.stderr?.on("data", (d: Buffer) => { if (errBytes < maxChars) { errChunks.push(d); errBytes += d.length; } });
    proc.on("error", (e) => { spawnError = e.message; stderr += `\n${e.message}`; finish(null); });
    proc.on("close", (code) => finish(code));
  });
}

/* ---- 危险命令拦截 ---- */

const DANGEROUS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\*|\.\s*$)/i, "递归强删根目录/家目录/当前目录"],
  [/\b(rd|rmdir)\s+\/s\b.*\b[a-z]:\\?\s*$/i, "递归删除整个盘符"],
  [/\bdel\s+\/[sfq]+\b.*\b[a-z]:\\/i, "批量删除盘符下文件"],
  [/\bformat\s+[a-z]:/i, "格式化磁盘"],
  [/\b(mkfs|dd\s+if=.*\sof=\/dev\/)/i, "破坏磁盘"],
  [/\b(shutdown|reboot|halt|poweroff)\b/i, "关机/重启"],
  [/(curl|wget|iwr|Invoke-WebRequest)[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression)\b/i, "下载并直接执行脚本"],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s+\.|stash\s+(drop|clear)|branch\s+-D)\b/i, "会改写/丢弃仓库状态或发布代码的 git 操作（回滚由 Agent 自己的检查点负责）"],
  [/\bgit\s+commit\b/i, "擅自提交会污染用户的提交历史"],
];

export function checkDangerous(command: string): string | null {
  for (const [re, why] of DANGEROUS) {
    if (re.test(command)) return why;
  }
  return null;
}

/** 供 Agent 工具调用：返回给模型看的"观察"文本，永不抛异常 */
export async function runCommand(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const danger = checkDangerous(command);
  if (danger) return `[已拒绝] 该命令被安全策略拦截：${danger}。如确有必要，请改用更安全的方式，或在最终回复中说明并让用户手动执行。`;

  const r = await execCommand(command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal: opts.signal });
  const body = stripAnsi(`${r.stdout}${r.stderr ? (r.stdout ? "\n" : "") + r.stderr : ""}`).trim();
  const out = truncateMiddle(body, 16_000);

  if (r.ok) return out || "(命令执行成功，无输出)";

  // 把"失败的性质"明确告诉模型，避免它对环境问题反复改代码
  const head =
    r.kind === "timeout" ? `[超时 ${Math.round((opts.timeoutMs ?? 60_000) / 1000)}s，进程已终止]` :
    r.kind === "env"     ? `[环境问题：${r.reason}；退出码 ${r.code ?? "无"}] 这不是代码缺陷，请不要通过修改业务代码来规避；换用其它可用命令，或在总结中说明该环境限制。` :
                           `[命令失败，退出码 ${r.code}]`;
  return `${head}\n${out}`.trim();
}
