import OpenAI from "openai";
import { HEARTBEAT_MS } from "./config.js";

export type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

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

export function msgSize(m: Msg): number {
  const c = (m as any).content;
  // 带图片的消息：base64 本身不计入字符预算，按固定开销估算
  let n = typeof c === "string" ? c.length
    : Array.isArray(c) ? c.reduce((s: number, p: any) => s + (p?.type === "text" ? String(p.text).length : 1500), 0)
    : c ? JSON.stringify(c).length : 0;
  const tcs = (m as any).tool_calls;
  if (tcs) n += JSON.stringify(tcs).length;
  return n;
}
