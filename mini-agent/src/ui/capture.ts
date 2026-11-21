import util from "node:util";

export type Chunk = { stream: "out" | "err"; text: string };

const METHODS = { log: "out", info: "out", debug: "out", warn: "err", error: "err" } as const;
type Method = keyof typeof METHODS;

/**
 * 把 console.* 的输出同时交给界面（Web）。agent 的所有进度/结果都走 console，所以不需要改动 agent 本身。
 * 只接管 console 方法、不碰 process.stdout.write：测试运行器等直接写流的代码不会被卷进来。
 *
 * passthrough：是否仍然写到原来的终端。默认只有在真正的终端里才写（无窗口的打包程序写 stdout 可能报错）。
 * 返回还原函数。
 */
export function captureConsole(onChunk: (c: Chunk) => void, opts: { passthrough?: boolean } = {}): () => void {
  const echo = opts.passthrough ?? Boolean(process.stdout.isTTY);
  const saved = {} as Record<Method, (...a: any[]) => void>;
  for (const name of Object.keys(METHODS) as Method[]) {
    const orig = console[name];
    saved[name] = orig;
    console[name] = (...args: any[]) => {
      try { onChunk({ stream: METHODS[name], text: util.format(...args) + "\n" }); } catch { /* 界面出问题不能拖垮 agent */ }
      if (echo) { try { orig.apply(console, args); } catch { /* 终端已不可写 */ } }
    };
  }
  return () => { for (const name of Object.keys(METHODS) as Method[]) console[name] = saved[name]; };
}
