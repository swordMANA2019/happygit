import OpenAI from "openai";
import {
  client, toolsFor, buildSystemPrompt, TOOLS, READ_TOOL_NAMES, WRITE_TOOL_NAMES, AGENT_ONLY_NAMES, type AgentMode,
} from "./llm.js";
import { readFile, writeFile, editFile, deleteFile, listFiles } from "./tools/fs.js";
import { searchCode } from "./tools/search.js";
import { JobManager, runCommandJob, jobOutput, stopJob, listJobs } from "./tools/jobs.js";
import { readDocument, loadImage } from "./tools/docs.js";
import { discoverSkills, loadSkillText } from "./skills.js";
import { isMcpToolName, type McpManager } from "./mcp.js";
import type { ToolCtx, ApproveFn } from "./tools/ctx.js";
import {
  MAX_STEPS, TOOL_OUTPUT_CAP, LLM_MAX_RETRIES, LLM_TIMEOUT_MS, CONTEXT_CHAR_BUDGET,
  LLM_FIRST_TOKEN_MS, LLM_IDLE_MS, LLM_TOTAL_MS, LLM_STREAM, HEARTBEAT_MS, EXTRA_BODY, EARLY_FOLD_RATIO,
} from "./config.js";
import { stats } from "./stats.js";
import { classifyLlmError } from "./errors.js";
import { sleep, truncateMiddle, fmtSecs, withHeartbeat } from "./util.js";
import { Workspace } from "./workspace.js";
import { resolveCwd } from "./guard.js";
import { repairMessages } from "./memory.js";
import { emptyState, renderStateBlock, updatePlan, saveNotes, type TaskState } from "./taskstate.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/* =========================================================================
 * 类型
 * ========================================================================= */

export type AgentStatus =
  | "done"       // 模型给出最终回答
  | "max_steps"  // 步数耗尽
  | "stuck"      // 反复做同一件事，强制终止
  | "llm_error"  // LLM 不可用（鉴权/额度/网络，重试后仍失败）
  | "aborted";   // 用户中断

export type AgentResult = {
  status: AgentStatus;
  text: string;
  /** 完整对话；可作为下一次 runAgent 的 opts.messages 以保持会话连续 */
  messages: Msg[];
  steps: number;
  toolCalls: number;
  /** 本次真正执行了多少次 run_command（自测验证用它判断"模型是不是真的跑过命令"） */
  commandRuns: number;
  /** 最近一次写入之后模型自己运行过的"有意义的命令"（排除 cat/ls 之类）：数量、最后一条是否成功、命令文本 */
  evidence: { runs: number; lastOk: boolean | null; lastCmd: string };
  workspace: Workspace;
};

export type AgentOpts = {
  /** 会话的工作目录 —— 不再有全局 ROOT/process.cwd() */
  root: string;
  sessionId: string;
  /** 会话级模型 —— 不再有全局可变的模型配置 */
  model: string;
  mode?: AgentMode;
  maxSteps?: number;
  signal?: AbortSignal;
  /** 会话历史（会被原地追加）。不传则新开一个会话；system 消息每回合都会按当前 mode 刷新 */
  messages?: Msg[];
  workspace?: Workspace;
  /** 原始任务描述（风险评分用），默认取 userContent */
  task?: string;
  approve?: ApproveFn;
  approved?: Set<string>;
  /** 用户授权过只读访问的项目外目录（Session 持有，跨回合保留） */
  extraRoots?: Set<string>;
  /** 首次读取项目外目录时征求同意 */
  askExternal?: (dir: string) => Promise<boolean>;
  beforeWrite?: () => Promise<string | void>;
  /** 计划与笔记（由 Session 持有，跨回合保留）；不传则只在本次调用内有效 */
  state?: TaskState;
  /** 后台任务管理器（Session 持有，跨回合保留）；不传则用进程级的共享实例 */
  jobs?: JobManager;
  /** 外部工具（MCP）；仅 agent 模式生效 */
  mcp?: McpManager;
  /** 本次任务用过的技能会被记在这里（fix 用它决定要跑哪些技能声明的验证） */
  usedSkills?: Set<string>;
  /** 子 Agent：只读、不能再 delegate、不向终端打印过程 */
  sub?: boolean;
};

let sharedJobs: JobManager | null = null;
const defaultJobs = () => (sharedJobs ??= new JobManager());

/** 同时运行的子 Agent 数量上限（防止一次 10 个 delegate 把接口限流） */
const MAX_PARALLEL_SUBAGENTS = 3;
let activeSubs = 0;
const subQueue: Array<() => void> = [];
async function withSubSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeSubs >= MAX_PARALLEL_SUBAGENTS) await new Promise<void>((r) => subQueue.push(r));
  activeSubs++;
  try { return await fn(); } finally { activeSubs--; subQueue.shift()?.(); }
}

/* =========================================================================
 * 工具分发：永不抛异常，任何失败都变成"观察"文本回给模型
 * ========================================================================= */

const READ_SET = new Set<string>(READ_TOOL_NAMES);
const WRITE_SET = new Set<string>(WRITE_TOOL_NAMES);
const AGENT_ONLY_SET = new Set<string>(AGENT_ONLY_NAMES);
/** 互不依赖、可以同一轮并发执行的调用：纯读 + 子 Agent */
/** 只是"看一眼"的命令：不能算作"改完后验证过"的证据 */
const TRIVIAL_CMD = /^\s*(cat|ls|dir|type|echo|pwd|cd|head|tail|wc|find|tree|which|where|get-content|get-childitem|git\s+(status|diff|log|show))\b/i;

const PARALLEL_SET = new Set<string>([...READ_TOOL_NAMES, "delegate"]);
/** 轮询类调用：合法地反复出现，不参与"原地打转"检测 */
const POLLING_SET = new Set<string>(["job_output", "list_jobs"]);

function validateArgs(name: string, args: any): string | null {
  const def = TOOLS.find((t) => (t as any).function.name === name) as any;
  if (!def) return null;
  const schema = def.function.parameters;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "参数必须是 JSON 对象";
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) return `缺少必填参数 ${key}`;
  }
  for (const [key, spec] of Object.entries<any>(schema.properties ?? {})) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (spec.type === "string" && typeof v !== "string") return `参数 ${key} 必须是字符串`;
    if (spec.type === "number" && typeof v !== "number") return `参数 ${key} 必须是数字`;
  }
  return null;
}

function explainFsError(name: string, args: any, e: any): string {
  const p = args?.path ?? "";
  switch (e?.code) {
    case "ENOENT": return `[工具错误] 路径不存在：${p}。请先用 list_files / search_code 确认正确路径。`;
    case "EISDIR": return `[工具错误] ${p} 是目录，不是文件。`;
    case "EACCES":
    case "EPERM":  return `[工具错误] 没有权限访问 ${p}（${e.code}）。这是环境限制，请换其它文件或在总结中说明。`;
    case "ENOSPC": return `[工具错误] 磁盘空间不足，无法写入。这是环境问题，请停止写入并在总结中说明。`;
    default:       return `[工具错误] ${name} 失败：${e?.message ?? e}`;
  }
}

async function dispatch(name: string, args: any, ctx: ToolCtx): Promise<string> {
  if (ctx.mode === "ask" && (WRITE_SET.has(name) || AGENT_ONLY_SET.has(name) || isMcpToolName(name))) {
    return "[已拒绝] 当前为只读模式，没有写文件/执行命令/调用外部工具的权限。";
  }
  const bad = validateArgs(name, args);
  if (bad) return `[参数错误] ${name}：${bad}。请按工具 schema 重新调用。`;

  try {
    // 第一次写入前的钩子（基线验证）；钩子自己保证只执行一次，且失败不能阻止写入
    let note = "";
    if (WRITE_SET.has(name) && ctx.beforeWrite) {
      try { note = (await ctx.beforeWrite()) || ""; } catch { /* 附加信息，失败就没有 */ }
    }
    const withNote = (s: string) => (note ? `${s}\n\n${note}` : s);
    switch (name) {
      case "read_file":   return await readFile(ctx, args.path, args.start_line, args.end_line);
      case "write_file":  return withNote(await writeFile(ctx, args.path, args.content));
      case "edit_file":   return withNote(await editFile(ctx, args.path, args.old_text, args.new_text));
      case "delete_file": return withNote(await deleteFile(ctx, args.path));
      case "update_plan": {
        const out = updatePlan(ctx.state, args);
        if (ctx.depth === 0) console.log(`\n📋 ${out}`);
        return out;
      }
      case "save_notes":  return saveNotes(ctx.state, args);
      case "list_files":  return await listFiles(ctx, args.path ?? ".", args.depth ?? 3);
      case "search_code": return await searchCode(ctx.root, args.query, args.max_results ?? 40);
      case "read_document": return await readDocument(ctx, args.path, args.start_page, args.end_page);
      case "view_image":  return await loadImage(ctx, args.path);
      case "use_skill": {
        const { text, skill } = await loadSkillText(await discoverSkills(ctx.root), args.name);
        if (skill) ctx.usedSkills.add(skill.name);
        return text;
      }
      case "run_command": {
        const cwd = resolveCwd(ctx.root, args.cwd);
        ctx.commandRuns++;
        return await runCommandJob(ctx.jobs, args.command, {
          cwd, timeoutMs: args.timeout_ms, background: args.background === true, signal: ctx.signal,
        });
      }
      case "job_output":  return await jobOutput(ctx.jobs, args.job_id, args.wait_ms, ctx.signal);
      case "stop_job":    return stopJob(ctx.jobs, args.job_id);
      case "list_jobs":   return listJobs(ctx.jobs);
      case "delegate": {
        if (ctx.depth > 0) return "[已拒绝] 子 Agent 不能再创建子 Agent，请自己直接完成。";
        const task = String(args.task);
        return await withSubSlot(async () => {
          console.log(`\n🔀 子任务开始：${preview(task.replace(/\s+/g, " "), 120)}`);
          const r = await runAgent(task, `## 运行环境\n- 项目根：${ctx.root}`, {
            root: ctx.root, sessionId: ctx.sessionId, model: ctx.model, mode: "ask", sub: true,
            maxSteps: 20, signal: ctx.signal, jobs: ctx.jobs, extraRoots: ctx.extraRoots,
          });
          console.log(`🔀 子任务结束（${r.status}，${r.steps} 步）`);
          return truncateMiddle(r.status === "done" ? r.text : `[子任务未完成：${r.status}] ${r.text}`, 8000);
        });
      }
      default:
        if (ctx.mcp && isMcpToolName(name)) {
          if (name === "mcp_search_tools") return ctx.mcp.search(args.query);
          if (name === "mcp_call") return await ctx.mcp.call(String(args.name), args.arguments, ctx.signal);
          return await ctx.mcp.call(name, args, ctx.signal);
        }
        return `[未知工具] ${name}。可用工具：${TOOLS.map((t) => (t as any).function.name).join(", ")}`;
    }
  } catch (e: any) {
    return explainFsError(name, args, e);
  }
}

/* =========================================================================
 * 上下文压缩：messages 只增不减会在长任务里撑爆窗口
 * 策略：保留 system + 任务 + 最近 N 条工具输出，较早的工具输出折叠成摘要。
 * 只改 content，不动 tool_call_id 配对，所以协议始终合法。
 * ========================================================================= */

function msgSize(m: Msg): number {
  const c = (m as any).content;
  // 带图片的消息：base64 本身不计入字符预算，按固定开销估算
  let n = typeof c === "string" ? c.length
    : Array.isArray(c) ? c.reduce((s: number, p: any) => s + (p?.type === "text" ? String(p.text).length : 1500), 0)
    : c ? JSON.stringify(c).length : 0;
  const tcs = (m as any).tool_calls;
  if (tcs) n += JSON.stringify(tcs).length;
  return n;
}

/**
 * 提前折叠：写大文件的任务里，每个 write_file 的整份内容都留在历史里、每一步都被重新发给模型——
 * 但这些文件已经在磁盘上了（需要时 read_file 即可）。历史长到预算的 EARLY_FOLD_RATIO 就开始折叠
 * 较早的 write_file/edit_file 大参数（最近 3 轮保留原样；保持 JSON 合法，路径等字段不动）。
 * 比"超预算才折叠"早得多：每步少发几万字符，就是每步少等几秒的预填充时间。
 */
export function foldOldWrites(messages: Msg[], budget = CONTEXT_CHAR_BUDGET, keepRecentTurns = 3): number {
  let total = messages.reduce((s, m) => s + msgSize(m), 0);
  if (total < budget * EARLY_FOLD_RATIO) return 0;

  const turns = messages.map((m, i) => ((m as any).tool_calls?.length ? i : -1)).filter((i) => i >= 0);
  const old = turns.slice(0, Math.max(turns.length - keepRecentTurns, 0));
  let folded = 0;
  for (const i of old) {
    for (const tc of (messages[i] as any).tool_calls ?? []) {
      const name = tc.function?.name;
      if (name !== "write_file" && name !== "edit_file") continue;
      const raw: string = tc.function?.arguments ?? "";
      if (raw.length < 1200) continue;
      try {
        const a = JSON.parse(raw);
        for (const k of ["content", "old_text", "new_text"]) {
          if (typeof a[k] === "string" && a[k].length > 500) a[k] = `[已折叠 ${a[k].length} 字符：这部分已写入磁盘，需要请 read_file]`;
        }
        const next = JSON.stringify(a);
        total -= raw.length - next.length;
        tc.function.arguments = next;
        folded++;
      } catch { /* 参数不是合法 JSON：不动 */ }
    }
  }
  return folded;
}

export function compactMessages(messages: Msg[], budget = CONTEXT_CHAR_BUDGET, keepRecent = 8): number {
  let total = messages.reduce((s, m) => s + msgSize(m), 0);
  if (total <= budget) return 0;

  let folded = 0;
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const foldable = toolIdx.slice(0, Math.max(toolIdx.length - keepRecent, 0));

  for (const i of foldable) {
    if (total <= budget) break;
    const m = messages[i] as any;
    if (typeof m.content !== "string" || m.content.length < 400) continue;
    const before = m.content.length;
    m.content = `[较早的工具输出已折叠，原 ${before} 字符；如需请重新调用工具] ${m.content.slice(0, 160).replace(/\s+/g, " ")}…`;
    total -= before - m.content.length;
    folded++;
  }

  // 仍超预算：折叠较早 assistant 里体积很大的 write_file 参数（保持 JSON 合法）
  if (total > budget) {
    const cut = messages.length - keepRecent * 2;
    for (let i = 2; i < cut && total > budget; i++) {
      const m = messages[i] as any;
      for (const tc of m.tool_calls ?? []) {
        const raw: string = tc.function?.arguments ?? "";
        if (raw.length < 2000) continue;
        try {
          const a = JSON.parse(raw);
          for (const k of ["content", "old_text", "new_text"]) {
            if (typeof a[k] === "string" && a[k].length > 500) a[k] = `[已折叠 ${a[k].length} 字符]`;
          }
          const next = JSON.stringify(a);
          total -= raw.length - next.length;
          tc.function.arguments = next;
          folded++;
        } catch { /* 参数本来就不是合法 JSON，不动它 */ }
      }
    }
  }
  return folded;
}

/* =========================================================================
 * LLM 调用：重试 + 退避 + 上下文溢出自救 + 可中断
 * ========================================================================= */

type LlmOutcome =
  | { ok: true; resp: OpenAI.Chat.Completions.ChatCompletion }
  | { ok: false; error: string; aborted?: boolean };

async function abortableSleep(ms: number, signal?: AbortSignal) {
  if (!signal) return sleep(ms);
  await Promise.race([
    sleep(ms),
    new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })),
  ]);
}

/** 网关不支持 stream 时自动降级为一次性响应（进程内记住，不再反复试） */
let streamingBroken = !LLM_STREAM;

type Completion = OpenAI.Chat.Completions.ChatCompletion;

/**
 * 一次性（非流式）请求：整个响应必须在 LLM_TIMEOUT_MS 内返回。
 * 写长文件（比如几百行的训练脚本）时模型要生成很久，这种方式很容易超时——所以默认走下面的流式版本。
 */
async function completeOnce(messages: Msg[], tools: OpenAI.Chat.Completions.ChatCompletionTool[], model: string, signal: AbortSignal | undefined, quiet: boolean): Promise<Completion> {
  return withHeartbeat(`等待模型响应（${currentStepLabel}）`, () =>
    client.chat.completions.create(
      { ...EXTRA_BODY, model, messages, tools, tool_choice: "auto", temperature: 0 } as any,
      { signal, timeout: LLM_TIMEOUT_MS },
    ), { quiet });
}

let currentStepLabel = "";
/** 最近一次成功调用的输出规模（流式才有思考字符数），给耗时统计用 */
let lastCallMeta = { out: 0, think: 0 };

/**
 * 流式请求：不再有"整个响应必须在 N 秒内完成"的限制，改为三道看门狗——
 *   首包超时（LLM_FIRST_TOKEN_MS）/ 数据流静默超时（LLM_IDLE_MS）/ 总时长上限（LLM_TOTAL_MS）。
 * 模型只要还在持续输出就不会超时；同时周期性打印"已收到多少字符、正在生成哪个工具调用"，终端不会看起来卡死。
 */
async function completeStream(messages: Msg[], tools: OpenAI.Chat.Completions.ChatCompletionTool[], model: string, signal: AbortSignal | undefined, quiet: boolean): Promise<Completion> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal?.aborted) ac.abort(); else signal?.addEventListener("abort", onAbort, { once: true });

  const t0 = Date.now();
  let lastChunk = t0;
  let seenFirst = false;
  let timeoutReason = "";
  let received = 0;
  let thinking = 0;
  let activeTool = "";

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - t0 > LLM_TOTAL_MS) timeoutReason = `单次响应超过总时限 ${fmtSecs(LLM_TOTAL_MS)}`;
    else if (!seenFirst && now - t0 > LLM_FIRST_TOKEN_MS) timeoutReason = `${fmtSecs(LLM_FIRST_TOKEN_MS)} 内没有收到任何响应`;
    else if (seenFirst && now - lastChunk > LLM_IDLE_MS) timeoutReason = `数据流中断：${fmtSecs(LLM_IDLE_MS)} 没有新数据`;
    if (timeoutReason) ac.abort();
  }, 1000);
  watchdog.unref?.();

  const progress = quiet ? null : setInterval(() => {
    const el = fmtSecs(Date.now() - t0);
    console.log(!seenFirst
      ? `⏳ 等待模型响应（${currentStepLabel}）…已 ${el}`
      : received === 0 && thinking > 0
        ? `🧠 模型思考中（${currentStepLabel}）…已 ${el}，思考 ${thinking} 字符（可用 AGENT_EXTRA_BODY 关闭思考以提速）`
        : `✍️  模型正在输出${activeTool ? `（${activeTool}）` : ""}…已 ${el}，收到 ${received} 字符${thinking ? `，思考 ${thinking} 字符` : ""}`);
  }, HEARTBEAT_MS);
  progress?.unref?.();

  try {
    const stream = (await client.chat.completions.create(
      { ...EXTRA_BODY, model, messages, tools, tool_choice: "auto", temperature: 0, stream: true } as any,
      { signal: ac.signal, timeout: LLM_FIRST_TOKEN_MS },
    )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    let content = "";
    let finish: string | null = null;
    const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

    for await (const chunk of stream) {
      lastChunk = Date.now();
      seenFirst = true;
      const ch: any = chunk.choices?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      if (d.content) { content += d.content; received += d.content.length; }
      // 推理模型（GLM/DeepSeek-R1/Qwen3 等）会先流出一大段"思考"，它不属于答案但同样占时间
      const think = d.reasoning_content ?? d.reasoning;
      if (typeof think === "string" && think) thinking += think.length;
      for (const t of d.tool_calls ?? []) {
        const i = t.index ?? 0;
        const cur = (calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (t.id) cur.id = t.id;
        // 名字只在第一块出现；个别兼容网关每块都带，所以已有名字就不再拼接
        if (t.function?.name && !cur.function.name) cur.function.name = t.function.name;
        if (t.function?.arguments) { cur.function.arguments += t.function.arguments; received += t.function.arguments.length; }
        if (cur.function.name) activeTool = cur.function.name;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }

    // SDK 的流在被 abort 时是"静默结束"而不是抛错：必须在这里自己判断，否则被看门狗截断的半截回复会被当成完整答案
    if (timeoutReason) throw Object.assign(new Error(`模型响应超时：${timeoutReason}`), { name: "APIConnectionTimeoutError" });
    if (!finish && calls.length) throw Object.assign(new Error("模型响应数据流意外中断（工具调用参数不完整）"), { name: "APIConnectionError" });

    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
    if (!content && !toolCalls.length && !finish) throw Object.assign(new Error("模型返回了空数据流"), { status: 502 });

    const dt = Date.now() - t0;
    lastCallMeta = { out: received, think: thinking };
    if (!quiet && dt > 20_000) console.log(`（本次模型调用用时 ${fmtSecs(dt)}，输出 ${received} 字符${thinking ? `，思考 ${thinking} 字符` : ""}）`);

    return {
      id: "stream", object: "chat.completion", created: Math.floor(t0 / 1000), model,
      choices: [{
        index: 0, logprobs: null, finish_reason: (finish ?? "stop") as any,
        message: { role: "assistant", content: content || null, refusal: null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      }],
    } as Completion;
  } catch (e: any) {
    // 我们自己的看门狗触发的中止：转成"可重试的超时"，并说清楚原因
    if (timeoutReason && !signal?.aborted) {
      throw Object.assign(new Error(`模型响应超时：${timeoutReason}`), { name: "APIConnectionTimeoutError" });
    }
    throw e;
  } finally {
    clearInterval(watchdog);
    if (progress) clearInterval(progress);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function callLLM(
  messages: Msg[], tools: OpenAI.Chat.Completions.ChatCompletionTool[], model: string,
  signal?: AbortSignal, quiet = false,
): Promise<LlmOutcome> {
  let overflowHandled = false;
  let timeouts = 0;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return { ok: false, error: "已中断", aborted: true };
    const callStart = Date.now();
    try {
      lastCallMeta = { out: 0, think: 0 };
      const resp = streamingBroken
        ? await completeOnce(messages, tools, model, signal, quiet)
        : await completeStream(messages, tools, model, signal, quiet);
      if (!resp.choices?.[0]?.message) throw Object.assign(new Error("模型返回了空 choices"), { status: 502 });
      const m: any = resp.choices[0].message;
      const outChars = lastCallMeta.out || ((m.content?.length ?? 0) + (m.tool_calls ?? []).reduce((s: number, t: any) => s + (t.function?.arguments?.length ?? 0), 0));
      // 子 Agent（quiet）的调用也算：它们确实占用了时间
      stats().llm(Date.now() - callStart, messages.reduce((s, x) => s + msgSize(x), 0), outChars, lastCallMeta.think);
      return { ok: true, resp };
    } catch (e: any) {
      if (signal?.aborted) return { ok: false, error: "已中断", aborted: true };
      const info = classifyLlmError(e);

      // 网关不支持 stream：降级为一次性响应后立刻重试（不算失败次数）
      if (!streamingBroken && (e?.status === 400 || e?.status === 404 || e?.status === 422 || e?.status === 501) && /stream/i.test(String(e?.message ?? ""))) {
        streamingBroken = true;
        console.error(`[llm] 接口不支持流式响应，已改用一次性响应（长输出更容易超时；可调大 AGENT_LLM_TIMEOUT_MS）`);
        attempt--;
        continue;
      }

      // 连续两次超时：重发同样的请求只会再超时一次。给模型一条提示，让它把输出拆小
      if (/超时|timed? ?out|Timeout/i.test(info.message) || e?.name === "APIConnectionTimeoutError") {
        timeouts++;
        if (timeouts === 2 && info.retryable && attempt < LLM_MAX_RETRIES) {
          messages.push({
            role: "user",
            content: "[系统] 前两次生成都超时了。请把输出拆小：长文件先用 write_file 写骨架/第一部分，再用 edit_file 分段补充；每次工具调用的内容控制在约 150 行以内。",
          });
          console.error("[llm] 连续超时，已提示模型把输出拆小");
        }
      }

      if (info.contextOverflow && !overflowHandled) {
        overflowHandled = true;
        const n = compactMessages(messages, Math.floor(CONTEXT_CHAR_BUDGET / 3), 4);
        console.error(`[llm] 上下文超限，已折叠 ${n} 处旧输出后重试`);
        if (n > 0) continue;
      }
      if (!info.retryable || attempt >= LLM_MAX_RETRIES) {
        return { ok: false, error: info.message };
      }
      const backoff = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 400);
      const wait = Math.max(info.retryAfterMs ?? 0, backoff);
      console.error(`[llm] 请求失败（${info.message.slice(0, 100)}），${(wait / 1000).toFixed(1)}s 后重试 ${attempt + 1}/${LLM_MAX_RETRIES}`);
      await abortableSleep(wait, signal);
    }
  }
}

/* =========================================================================
 * 主循环：thought → action → observation
 * ========================================================================= */

const preview = (s: string, n: number) => s.length > n ? s.slice(0, n) + " …" : s;

export async function runAgent(userContent: string, context: string, opts: AgentOpts): Promise<AgentResult> {
  const mode: AgentMode = opts.mode ?? "agent";
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const signal = opts.signal;

  // 会话历史由调用方（Session）持有并原地追加：同一个数组贯穿 ask / diag / fix 所有回合，
  // 模型每次都看到完整的"用户说了什么 → 我调了什么工具 → 看到了什么 → 我回答了什么"。
  const messages: Msg[] = opts.messages ?? [];

  // 系统提示词每回合按当前模式重建（ask/agent 的工具集与规则不同），运行环境/验证器/项目规则放在系统提示里：
  // 它们不属于"对话"，所以不会被历史压缩吞掉，也不会过期（每回合刷新）。
  // 计划与笔记同样放在系统提示末尾，并且在每一步重新渲染（模型刚更新完计划，下一步就能看到）
  const state = opts.state ?? emptyState();
  const makeSys = (): Msg => ({
    role: "system",
    content: buildSystemPrompt(mode) + (context ? `\n\n${context}` : "") + renderStateBlock(state),
  });
  if (messages[0]?.role === "system") messages[0] = makeSys(); else messages.unshift(makeSys());

  repairMessages(messages);
  messages.push({ role: "user", content: userContent });

  const ws = opts.workspace ?? new Workspace(opts.root);
  const ctx: ToolCtx = {
    root: opts.root,
    sessionId: opts.sessionId,
    mode,
    task: opts.task ?? userContent,
    workspace: ws,
    approve: opts.approve,
    approved: opts.approved ?? new Set<string>(),
    extraRoots: opts.extraRoots ?? new Set<string>(),
    askExternal: opts.askExternal,
    signal,
    beforeWrite: opts.beforeWrite,
    state,
    model: opts.model,
    jobs: opts.jobs ?? defaultJobs(),
    mcp: opts.mcp,
    usedSkills: opts.usedSkills ?? new Set<string>(),
    pendingImages: [],
    commandRuns: 0,
    depth: opts.sub ? 1 : 0,
  };
  const log: (...a: any[]) => void = opts.sub ? () => {} : console.log;
  const tools = toolsFor(mode, { extra: mode === "agent" ? opts.mcp?.toolDefs() : undefined, sub: opts.sub });

  let step = 0;
  let toolCalls = 0;
  let writes = 0;
  let emptyReplies = 0;
  let lastText = "";
  const seen = new Map<string, number>();
  let evidence: AgentResult["evidence"] = { runs: 0, lastOk: null, lastCmd: "" };

  const result = (status: AgentStatus, text: string): AgentResult =>
    ({ status, text, messages, steps: step, toolCalls, commandRuns: ctx.commandRuns, evidence, workspace: ws });

  try {
    for (step = 1; step <= maxSteps; step++) {
      if (signal?.aborted) return result("aborted", lastText || "已中断");

      foldOldWrites(messages);
      compactMessages(messages);
      if (messages[0]?.role === "system") messages[0] = makeSys();
      currentStepLabel = `步骤 ${step}`;
      const out = await callLLM(messages, tools, opts.model, signal, !!opts.sub);
      if (!out.ok) return result(out.aborted ? "aborted" : "llm_error", out.error);

      const choice = out.resp.choices[0];
      const msg = choice.message;
      const calls = (msg.tool_calls ?? []).filter((tc: any) => tc.type === "function" || tc.function) as any[];
      messages.push({ role: "assistant", content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) } as Msg);
      if (msg.content) lastText = msg.content;

      /* ---- 没有 action：要么是最终回答，要么是异常空回复 ---- */
      if (!calls.length) {
        if (!msg.content?.trim()) {
          if (++emptyReplies <= 1) {
            messages.push({ role: "user", content: "你的回复为空。请继续调用工具完成任务，或直接给出最终总结。" });
            continue;
          }
          return result("done", "（模型无输出）");
        }
        const note = choice.finish_reason === "length" ? "\n\n⚠️ 输出因长度限制被截断。" : "";
        return result("done", msg.content + note);
      }

      /* ---- thought：模型在调用工具前的自述 ---- */
      if (msg.content?.trim()) log(`\n💭 ${preview(msg.content.trim(), 300)}`);

      /* ---- action + observation ---- */
      const runOne = async (tc: any): Promise<string> => {
        const fn: string = tc.function.name;
        let args: any;
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // 解析失败不能静默变成 {} 再用 undefined 参数执行工具：明确告诉模型，常见原因是输出被截断
          log(`\n[步骤 ${step}] ${fn} (参数 JSON 非法)`);
          return `[参数错误] ${fn} 的 arguments 不是合法 JSON（可能因输出过长被截断）。请缩小单次修改范围后重新调用。`;
        }
        log(`\n[步骤 ${step}] ${fn} ${preview(JSON.stringify(args), 160)}`);

        // 重复检测：同一调用（run_command 以"期间是否有过写入"区分）反复出现 = 在原地打转。
        // 轮询后台任务本来就要反复调用同一个 job_output，不算原地打转
        const key = `${fn}:${JSON.stringify(args)}${fn === "run_command" ? `#w${writes}` : ""}`;
        const n = POLLING_SET.has(fn) ? 0 : (seen.get(key) ?? 0) + 1;
        if (!POLLING_SET.has(fn)) seen.set(key, n);

        const t0 = Date.now();
        let res = await dispatch(fn, args, ctx);
        stats().tool(fn, Date.now() - t0);
        if (WRITE_SET.has(fn) && res.startsWith("已")) {
          writes++;
          evidence = { runs: 0, lastOk: null, lastCmd: "" };   // 改了文件：之前跑过的命令不再算数
        }
        if (fn === "run_command" && !res.startsWith("[已拒绝]") && !TRIVIAL_CMD.test(String(args.command ?? ""))) {
          const failed = /^\[(命令失败|命令已被终止|工具错误|参数错误|已中断)/.test(res);
          const bg = /^\[(已在后台|仍在运行)/.test(res);
          evidence = { runs: evidence.runs + 1, lastOk: bg ? null : !failed, lastCmd: String(args.command ?? "") };
        }
        if (n === 3) res += `\n[提示] 你已第 ${n} 次执行完全相同的调用且没有任何新进展。请换一种思路，或结束并说明阻塞点。`;
        return res;
      };

      const batch = calls.every((tc) => PARALLEL_SET.has(tc.function.name));
      const results: string[] = new Array(calls.length);
      if (batch) {
        // 纯读操作互不依赖，并发执行
        await Promise.all(calls.map(async (tc, i) => { results[i] = await runOne(tc); }));
      } else {
        for (let i = 0; i < calls.length; i++) {
          // 中断时也必须给每个 tool_call 配一条 tool 消息，否则会话无法继续
          results[i] = signal?.aborted ? "[已中断，未执行]" : await runOne(calls[i]);
        }
      }

      let stuck = false;
      calls.forEach((tc, i) => {
        toolCalls++;
        const r = results[i];
        log(preview(r, 300));
        messages.push({ role: "tool", tool_call_id: tc.id, content: truncateMiddle(r, TOOL_OUTPUT_CAP) });
        if ([...seen.values()].some((v) => v >= 5)) stuck = true;
      });

      // view_image：图片不能放进 tool 消息，只能作为紧随其后的一条 user 消息；旧图片换成占位文字，避免上下文被图片占满
      if (ctx.pendingImages.length) {
        for (const m of messages) {
          if (m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p?.type === "image_url")) {
            (m as any).content = "[较早的图片已省略]";
          }
        }
        messages.push({
          role: "user",
          content: [
            { type: "text", text: `[系统] 你刚才请求查看的图片：${ctx.pendingImages.map((i) => i.path).join(", ")}` },
            ...ctx.pendingImages.map((i) => ({ type: "image_url" as const, image_url: { url: i.dataUrl } })),
          ],
        });
        ctx.pendingImages.length = 0;
      }
      if (stuck) return result("stuck", "Agent 反复执行相同操作且没有进展，已强制终止。请换一种描述或拆分任务。");
    }
    step = maxSteps;
    return result("max_steps", lastText ? `${lastText}\n\n（已达到最大步数 ${maxSteps}，任务可能未完成）` : `已达到最大步数 ${maxSteps}，任务未完成，请拆分后重试。`);
  } catch (e: any) {
    // 最后的安全网：agent 内部的未预料异常也不能让调用方崩溃
    return result("llm_error", `Agent 内部错误：${e?.message ?? e}`);
  }
}
