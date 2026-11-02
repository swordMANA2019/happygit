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

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
