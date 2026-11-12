import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { client } from "./llm.js";
import {
  CONTEXT_CHAR_BUDGET, LLM_TIMEOUT_MS, SUMMARY_MAX_TOKENS, SUMMARY_MODEL, SUMMARY_PARALLEL, BG_COMPACT, extraBodyFor,
} from "./config.js";
import { truncateMiddle, withHeartbeat } from "./util.js";
import type { TaskState } from "./taskstate.js";

/**
 * 会话记忆。
 *
 * 记忆 = 一条连续的 OpenAI messages 数组（和 Cursor / Claude Code 的做法一致），而不是"几句话的摘要"：
 *   user → assistant(tool_calls) → tool → … → assistant(最终回答) → user → …
 * 这样模型能看到自己上一轮读过什么文件、改了什么、验证结果是什么，追问时无需重新摸索。
 *
 * 三层机制：
 *   1. 原样保留（默认）：ask / diag / fix 共用同一个数组。
 *   2. 折叠旧工具输出（agent.ts 的 compactMessages）：只改 content，不破坏 tool_call 配对。
 *   3. LLM 摘要压缩（本文件 compactConversation）：历史接近预算时，把较早的回合总结成一条摘要，
 *      保留最近几个回合的原文。摘要分段并行生成、关闭思考、限制输出长度；并且每回合结束后在后台预先做好
 *      （BackgroundCompactor），下一回合开始时直接套用，不让用户等。
 * 另外：系统提示词（含运行环境/验证器/项目规则 AGENTS.md）每回合重建，不属于"对话"，不会被压缩吞掉。
 */

export type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** 历史超过预算的这个比例就触发摘要压缩（留出余量给本回合的工具输出） */
const SUMMARIZE_AT = 0.5;
/** 压缩时原样保留的最近"用户消息"条数（含其后的全部工具往返） */
const KEEP_USER_TURNS = 2;

/** 消息文本：多段内容（带图片）只取文字部分，图片用占位符，避免 base64 进入摘要/大小估算/落盘 */
function textOfContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (p?.type === "text" ? String(p.text) : "[图片]")).join("\n");
  return c ? JSON.stringify(c) : "";
}

function sizeOf(m: Msg): number {
  const c = (m as any).content;
  let n = textOfContent(c).length;
  const tcs = (m as any).tool_calls;
  if (tcs) n += JSON.stringify(tcs).length;
  return n;
}

export const conversationSize = (messages: Msg[]) => messages.reduce((s, m) => s + sizeOf(m), 0);

/**
 * 修复"悬空的 tool_call"：assistant 发起了工具调用，但没有对应的 tool 回复
 * （上一回合异常/中断时可能留下）。OpenAI 协议要求每个 tool_call 都有回复，否则下一次请求直接 400。
 */
export function repairMessages(messages: Msg[]): number {
  let fixed = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const missing = new Set<string>(m.tool_calls.map((t: any) => t.id));
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      missing.delete((messages[j] as any).tool_call_id);
      j++;
    }
    if (missing.size) {
      const fill = [...missing].map((id) => ({ role: "tool", tool_call_id: id, content: "[已中断，未执行]" }) as Msg);
      messages.splice(j, 0, ...fill);
      fixed += fill.length;
      i = j + fill.length - 1;
    }
  }
  return fixed;
}

/** 往会话里记一条"系统事实"（如：改动被回滚 / 用户执行了 /undo），让模型知道文件现在是什么状态 */
export function addNote(messages: Msg[], text: string) {
  if (messages.length === 0) return;   // 还没有任何对话，没必要记
  messages.push({ role: "user", content: `[系统通知] ${text}` });
  messages.push({ role: "assistant", content: "收到，我会以此为准。" });
}

/* ---------------------------------------------------------------------------
 * LLM 摘要压缩
 * ------------------------------------------------------------------------- */

const SUMMARY_PROMPT = `你在为一个编程 Agent 压缩对话历史。下面是较早的对话记录（用户、助手、工具调用与结果）。
请写一份供"接手的 Agent"继续工作用的摘要，用中文，要点式，必须保留：
1. 用户的目标、明确的要求/约束/偏好，以及用户用过的指代（"它""那个文件"指的是什么）。
2. 涉及的文件路径；每个文件做过什么改动（改了什么、为什么）；哪些改动被回滚/撤销了。
3. 已得出的结论和发现（含 文件:行号）；已做过的验证及结果（命令 + 通过/失败 + 关键报错）。
4. 失败的尝试及原因（避免重复踩坑）。
5. 尚未完成的事项，以及上一轮助手向用户提出、还在等回答的问题。
不要复述工具的原始长输出，不要编造记录里没有的事实。`;

function render(m: Msg): string {
  const text = textOfContent((m as any).content);
  // 上一次压缩留下的摘要要完整带入（不能被当成普通用户消息截断到 3000 字符）
  if (m.role === "user") return `用户：${text.slice(0, text.startsWith("[此前对话的摘要") ? 9000 : 3000)}`;
  if (m.role === "tool") return `[工具结果] ${text.slice(0, 600)}`;
  if (m.role === "assistant") {
    const calls = ((m as any).tool_calls ?? [])
      .map((t: any) => `[调用 ${t.function?.name}(${String(t.function?.arguments ?? "").slice(0, 200)})]`)
      .join(" ");
    return `助手：${text.slice(0, 3000)} ${calls}`.trim();
  }
  return "";
}

/** 后台预压缩的触发线：比"阻塞式压缩"（SUMMARIZE_AT）更早，让结果在下一回合开始前就绪 */
const BG_SUMMARIZE_AT = 0.4;
/** 每段送去摘要的目标字符数：越小并行度越高、单次输出越短，但跨段的指代信息会丢得更多 */
const CHUNK_TARGET = 15_000;
const CHUNK_MAX = 30_000;

type Plan = { cut: number; older: Msg[]; chunks: string[] };

/**
 * 决定要不要压缩、压缩哪一段。切点总是落在某条 user 消息之前，所以 assistant.tool_calls 与 tool 回复不会被拆开。
 * 同步完成（包括把消息渲染成文本）：之后即使 messages 被改动，已经取走的快照也不受影响。
 */
function planCompaction(messages: Msg[], ratio: number): Plan | null {
  if (conversationSize(messages) <= CONTEXT_CHAR_BUDGET * ratio) return null;
  // 只有"用户真正说的话"才是回合边界：系统注入的 user 消息（[系统…] 超时/空回复提示、[系统通知]、上次的摘要）不算，
  // 否则一个回合会被它们切成几段，"保留最近 2 个回合原文"实际只保留了半个回合
  const isRealUser = (m: Msg, i: number) => {
    if (m.role !== "user" || i === 0) return false;
    const t = textOfContent((m as any).content);
    return !(t.startsWith("[系统") || t.startsWith("[此前对话的摘要") || t.startsWith("[较早的图片"));
  };
  const userIdx = messages.map((m, i) => (isRealUser(m, i) ? i : -1)).filter((i) => i > 0);
  if (userIdx.length <= KEEP_USER_TURNS) return null;     // 只有一个超长回合：交给折叠处理
  const cut = userIdx[userIdx.length - KEEP_USER_TURNS];
  const older = messages.slice(1, cut);                   // 0 是 system
  return { cut, older, chunks: splitTranscript(older) };
}

/** 把较早的消息按顺序切成 1~SUMMARY_PARALLEL 段（只在消息边界切），每段文本规模接近 CHUNK_TARGET */
function splitTranscript(older: Msg[]): string[] {
  const lines = older.map(render).filter(Boolean);
  const total = lines.reduce((s, l) => s + l.length + 1, 0);
  const n = Math.min(SUMMARY_PARALLEL, Math.max(1, Math.ceil(total / CHUNK_TARGET)));
  const per = total / n;
  const chunks: string[][] = [[]];
  let size = 0;
  for (const l of lines) {
    if (size >= per && chunks.length < n) { chunks.push([]); size = 0; }
    chunks[chunks.length - 1].push(l);
    size += l.length + 1;
  }
  return chunks.map((c) => truncateMiddle(c.join("\n"), CHUNK_MAX));
}

async function summarizeChunk(text: string, idx: number, n: number, model: string, signal?: AbortSignal): Promise<string | null> {
  const part = n > 1 ? `\n\n（这是较早对话按时间顺序切成的第 ${idx + 1}/${n} 段，只总结这一段；其它段由别人处理。）` : "";
  const resp = await client.chat.completions.create(
    {
      ...extraBodyFor(model),            // 关键：和主循环一样关闭思考，否则推理模型会先"想"几十秒再写摘要
      model, temperature: 0, max_tokens: SUMMARY_MAX_TOKENS,   // 限制输出长度 = 限制耗时
      messages: [{ role: "system", content: SUMMARY_PROMPT + part }, { role: "user", content: text }],
    } as any,
    { signal, timeout: LLM_TIMEOUT_MS },
  ) as OpenAI.Chat.Completions.ChatCompletion;
  return resp.choices?.[0]?.message?.content?.trim() || null;
}

/** 各段并行摘要后按顺序拼接；任何一段失败就整体放弃（返回 null），由 agent.ts 的字符折叠兜底 */
async function summarize(plan: Plan, model: string, signal?: AbortSignal): Promise<string | null> {
  const m = SUMMARY_MODEL || model;
  const n = plan.chunks.length;
  try {
    const parts = await Promise.all(plan.chunks.map((c, i) => summarizeChunk(c, i, n, m, signal)));
    if (parts.some((p) => !p)) return null;
    return n === 1 ? parts[0]! : parts.map((p, i) => `【第 ${i + 1}/${n} 段】\n${p}`).join("\n\n");
  } catch {
    return null;
  }
}

/** 把摘要写回 messages。快照里的消息必须仍原样在原位置（期间被回滚/清空/重排就放弃），返回是否真的应用了 */
function applySummary(messages: Msg[], plan: Plan, summary: string): boolean {
  if (messages.length < plan.cut) return false;
  for (let i = 0; i < plan.older.length; i++) if (messages[1 + i] !== plan.older[i]) return false;
  messages.splice(
    1, plan.cut - 1,
    { role: "user", content: `[此前对话的摘要（较早的 ${plan.older.length} 条消息已压缩）]\n${summary}` },
    { role: "assistant", content: "已了解此前的进展，我会基于这份摘要继续。" },
  );
  console.error(`[memory] 历史已压缩：${plan.older.length} 条消息 → 1 条摘要`);
  return true;
}

/**
 * 历史过长时，把较早的回合压成一条摘要（原地修改 messages），阻塞直到完成。返回是否真的压缩了。
 * 失败（LLM 不可用等）时静默返回 false —— agent.ts 里还有按字符折叠的兜底。
 */
export async function compactConversation(messages: Msg[], model: string, signal?: AbortSignal): Promise<boolean> {
  const plan = planCompaction(messages, SUMMARIZE_AT);
  if (!plan) return false;
  console.log(`\n🗜️  对话较长，正在整理历史（${plan.chunks.length} 段${plan.chunks.length > 1 ? "并行" : ""}）…`);
  const summary = await withHeartbeat("整理对话历史", () => summarize(plan, model, signal));
  return summary ? applySummary(messages, plan, summary) : false;
}

/**
 * 后台压缩：每个回合结束后（用户正在读结果/打字的空档）就把较早的历史摘要好，
 * 下一回合开始时直接套用，不再让用户干等。结果只在回合开始的安全点（settle）写回 messages，
 * 期间对话被 /undo、/clear、/cd、/resume 改动过的话，快照校验失败就丢弃。
 */
export class BackgroundCompactor {
  private job: { plan: Plan; promise: Promise<string | null>; ac: AbortController; done: boolean } | null = null;

  /** 回合结束时调用：历史已经偏长就开始后台摘要（不阻塞、不打印） */
  schedule(messages: Msg[], model: string): void {
    if (!BG_COMPACT || this.job) return;
    const plan = planCompaction(messages, BG_SUMMARIZE_AT);
    if (!plan) return;
    const ac = new AbortController();
    const job = { plan, ac, done: false, promise: null as unknown as Promise<string | null> };
    job.promise = summarize(plan, model, ac.signal).finally(() => { job.done = true; });
    this.job = job;
  }

  /** 回合开始时调用：套用后台结果（还没好就等它）；没有后台结果、历史仍然太长时，退回阻塞式压缩 */
  async settle(messages: Msg[], model: string, signal?: AbortSignal): Promise<boolean> {
    const job = this.job;
    let applied = false;
    if (job) {
      if (signal?.aborted) return false;
      if (!job.done) console.log(`\n🗜️  后台整理历史尚未完成，等待它结束…`);
      const aborted = new Promise<"abort">((r) => signal?.addEventListener("abort", () => r("abort"), { once: true }));
      const res = await withHeartbeat("整理对话历史", () => Promise.race([job.promise, aborted]), { quiet: job.done });
      if (res === "abort") return false;        // 用户中断：后台任务保留，下个回合再收
      this.job = null;
      if (res) applied = applySummary(messages, job.plan, res);
    }
    return (await compactConversation(messages, model, signal)) || applied;
  }

  /** 对话被整体替换/清空时丢弃后台结果 */
  cancel(): void {
    this.job?.ac.abort();
    this.job = null;
  }
}

/* ---------------------------------------------------------------------------
 * 落盘（对应 Cursor 重启后还能看到历史会话）
 * ------------------------------------------------------------------------- */

const FILE = (root: string) => path.join(root, ".agent", "conversation.json");

/** 对话和任务状态（计划/笔记）一起落盘：它们是同一份"工作记忆" */
export async function saveConversation(root: string, messages: Msg[], state?: TaskState): Promise<void> {
  try {
    if (messages.length === 0) return;
    await fs.mkdir(path.join(root, ".agent"), { recursive: true });
    // 图片的 base64 不落盘：恢复后改成占位文字
    const slim = messages.map((m) =>
      Array.isArray((m as any).content) ? ({ ...m, content: textOfContent((m as any).content) } as Msg) : m);
    await fs.writeFile(FILE(root), JSON.stringify({ savedAt: Date.now(), messages: slim, state }));
  } catch { /* 持久化失败不应影响主流程 */ }
}

export async function loadConversation(root: string): Promise<{ messages: Msg[]; state?: Partial<TaskState> } | null> {
  try {
    const data = JSON.parse(await fs.readFile(FILE(root), "utf-8"));
    return Array.isArray(data.messages) && data.messages.length ? { messages: data.messages as Msg[], state: data.state } : null;
  } catch { return null; }
}

export async function clearConversation(root: string): Promise<void> {
  try { await fs.rm(FILE(root), { force: true }); } catch { /* ignore */ }
}
