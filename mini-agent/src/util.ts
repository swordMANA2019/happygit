import { HEARTBEAT_MS } from "./config.js";

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * 保留头尾、截掉中间。
 * 编译/测试日志的关键信息（最终的错误汇总）几乎总在末尾，只截头部会把它丢掉。
 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n…（中间省略 ${dropped} 字符）…\n${text.slice(text.length - tail)}`;
}

/** 12s / 3m05s */
export function fmtSecs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * 慢操作的进度提示：fn 运行期间，每隔 HEARTBEAT_MS 打印一行"仍在进行"。
 * 没有它，终端在验证/评审/整理历史这些阶段会长时间没有任何输出，看起来像卡死。
 */
export async function withHeartbeat<T>(label: string, fn: () => Promise<T>, opts: { quiet?: boolean; intervalMs?: number } = {}): Promise<T> {
  if (opts.quiet) return fn();
  const t0 = Date.now();
  const timer = setInterval(() => console.log(`⏳ ${label}…（已 ${fmtSecs(Date.now() - t0)}）`), opts.intervalMs ?? HEARTBEAT_MS);
  timer.unref?.();
  try { return await fn(); } finally { clearInterval(timer); }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
