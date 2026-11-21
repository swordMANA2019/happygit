import util from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 两条输出通道（界面用得上，终端行为不变）：
 *
 *  1. 用户可见内容：命令的结果、助手的回答、改动摘要……用 say() 输出。
 *  2. ReAct 过程：思考 / 动作 / 观察，用 emitTrace() 输出（结构化事件，界面把它们折叠显示）。
 *
 * 其余所有 console.*（进度心跳、[probe] [llm] [audit] 之类的运行日志）在界面里不显示，只写进后端日志文件。
 *
 * 没有界面（终端 REPL / 单次调用）时：say = console.log，emitTrace 打印成原来的文字格式。
 * 有界面时：由 server 在每个对话的执行上下文里提供处理函数（AsyncLocalStorage，所以多个对话并发也不会串）。
 */

export type TraceKind = "thought" | "action" | "observation" | "plan";

export type TraceEvent = {
  kind: TraceKind;
  /** 第几步（plan 可省略） */
  step?: number;
  /** 把同一次调用的 action 和 observation 对上 */
  id?: string;
  /** 工具名（action / observation） */
  name?: string;
  /**
   * thought：模型在调用工具前的自述
   * action：参数（JSON 文本）
   * observation：工具返回
   * plan：计划文本
   */
  text: string;
  /** thought 的补充：模型的"推理/思考"内容（reasoning_content），有就带上 */
  detail?: string;
  /** observation 是否成功 */
  ok?: boolean;
  /** 流式 thought：同一个 id 的多个事件是同一段思考。append = text 是追加的增量；done = 这段思考结束（text 可为空） */
  append?: boolean;
  done?: boolean;
};

export type UiContext = {
  trace(ev: TraceEvent): void;
  say(text: string): void;
};

export const uiContext = new AsyncLocalStorage<UiContext>();

const preview = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);

/** 终端里的老格式（也是后端日志里的格式） */
export function formatTrace(ev: TraceEvent): string {
  if (ev.kind === "thought" && ev.done && !ev.text) return "";
  switch (ev.kind) {
    case "thought": return `\n💭 ${preview(ev.text.trim(), 300)}`;
    case "action": return `\n[步骤 ${ev.step ?? "?"}] ${ev.name ?? ""} ${preview(ev.text, 160)}`;
    case "observation": return preview(ev.text, 300);
    case "plan": return `\n📋 ${ev.text}`;
  }
}

export function emitTrace(ev: TraceEvent): void {
  const c = uiContext.getStore();
  if (c) c.trace(ev);
  else console.log(formatTrace(ev));
}

/** 用户可见的输出。界面里只有它和 ReAct 过程会显示；其它 console.* 都进后端日志 */
export function say(...args: unknown[]): void {
  const c = uiContext.getStore();
  if (c) c.say(util.format(...args) + "\n");
  else console.log(...args);
}

/** 用户可见的结果 + 只给终端看的细节（界面里细节进后端日志）：fix 的验证记录就是这种 */
export function sayWithLog(text: string, log: string): void {
  const c = uiContext.getStore();
  if (c) { c.say(text + "\n"); if (log) console.log(log); }       // console.* 在界面里就是后端日志
  else console.log(log ? `${text}\n${log}` : text);
}
