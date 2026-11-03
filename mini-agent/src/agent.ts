import OpenAI from "openai";
import {
  client, toolsFor, buildSystemPrompt, TOOLS, READ_TOOL_NAMES, WRITE_TOOL_NAMES, type AgentMode,
} from "./llm.js";
import { readFile, writeFile, editFile, deleteFile, listFiles } from "./tools/fs.js";
import { searchCode } from "./tools/search.js";
import { runCommand } from "./tools/shell.js";
import type { ToolCtx, ApproveFn } from "./tools/ctx.js";
import {
  MAX_STEPS, TOOL_OUTPUT_CAP, LLM_MAX_RETRIES, LLM_TIMEOUT_MS, CONTEXT_CHAR_BUDGET,
} from "./config.js";
import { classifyLlmError } from "./errors.js";
import { sleep, truncateMiddle } from "./util.js";
import { Workspace } from "./workspace.js";
import { resolveCwd } from "./guard.js";
import { repairMessages } from "./memory.js";

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
  beforeWrite?: () => Promise<string | void>;
};

/* =========================================================================
 * 工具分发：永不抛异常，任何失败都变成"观察"文本回给模型
 * ========================================================================= */

const READ_SET = new Set<string>(READ_TOOL_NAMES);
const WRITE_SET = new Set<string>(WRITE_TOOL_NAMES);

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
  if (ctx.mode === "ask" && WRITE_SET.has(name)) {
    return "[已拒绝] 当前为只读模式，没有写文件权限。";
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
      case "list_files":  return await listFiles(ctx, args.path ?? ".", args.depth ?? 3);
      case "search_code": return await searchCode(ctx.root, args.query, args.max_results ?? 40);
      case "run_command": {
        const cwd = resolveCwd(ctx.root, args.cwd);
        return await runCommand(args.command, { cwd, timeoutMs: args.timeout_ms, signal: ctx.signal });
      }
      default:
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
  let n = typeof c === "string" ? c.length : c ? JSON.stringify(c).length : 0;
  const tcs = (m as any).tool_calls;
  if (tcs) n += JSON.stringify(tcs).length;
  return n;
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

async function callLLM(messages: Msg[], mode: AgentMode, model: string, signal?: AbortSignal): Promise<LlmOutcome> {
  let overflowHandled = false;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return { ok: false, error: "已中断", aborted: true };
    try {
      const resp = await client.chat.completions.create(
        { model, messages, tools: toolsFor(mode), tool_choice: "auto", temperature: 0 },
        { signal, timeout: LLM_TIMEOUT_MS },
      );
      if (!resp.choices?.[0]?.message) throw Object.assign(new Error("模型返回了空 choices"), { status: 502 });
      return { ok: true, resp };
    } catch (e: any) {
      if (signal?.aborted) return { ok: false, error: "已中断", aborted: true };
      const info = classifyLlmError(e);

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
  const sys: Msg = { role: "system", content: buildSystemPrompt(mode) + (context ? `\n\n${context}` : "") };
  if (messages[0]?.role === "system") messages[0] = sys; else messages.unshift(sys);

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
    signal,
    beforeWrite: opts.beforeWrite,
  };

  let step = 0;
  let toolCalls = 0;
  let writes = 0;
  let emptyReplies = 0;
  let lastText = "";
  const seen = new Map<string, number>();

  const result = (status: AgentStatus, text: string): AgentResult =>
    ({ status, text, messages, steps: step, toolCalls, workspace: ws });

  try {
    for (step = 1; step <= maxSteps; step++) {
      if (signal?.aborted) return result("aborted", lastText || "已中断");

      compactMessages(messages);
      const out = await callLLM(messages, mode, opts.model, signal);
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
      if (msg.content?.trim()) console.log(`\n💭 ${preview(msg.content.trim(), 300)}`);

      /* ---- action + observation ---- */
      const runOne = async (tc: any): Promise<string> => {
        const fn: string = tc.function.name;
        let args: any;
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // 解析失败不能静默变成 {} 再用 undefined 参数执行工具：明确告诉模型，常见原因是输出被截断
          console.log(`\n[步骤 ${step}] ${fn} (参数 JSON 非法)`);
          return `[参数错误] ${fn} 的 arguments 不是合法 JSON（可能因输出过长被截断）。请缩小单次修改范围后重新调用。`;
        }
        console.log(`\n[步骤 ${step}] ${fn} ${preview(JSON.stringify(args), 160)}`);

        // 重复检测：同一调用（run_command 以"期间是否有过写入"区分）反复出现 = 在原地打转
        const key = `${fn}:${JSON.stringify(args)}${fn === "run_command" ? `#w${writes}` : ""}`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);

        let res = await dispatch(fn, args, ctx);
        if (WRITE_SET.has(fn) && res.startsWith("已")) writes++;
        if (n === 3) res += `\n[提示] 你已第 ${n} 次执行完全相同的调用且没有任何新进展。请换一种思路，或结束并说明阻塞点。`;
        return res;
      };

      const batch = calls.every((tc) => READ_SET.has(tc.function.name));
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
        console.log(preview(r, 300));
        messages.push({ role: "tool", tool_call_id: tc.id, content: truncateMiddle(r, TOOL_OUTPUT_CAP) });
        if ([...seen.values()].some((v) => v >= 5)) stuck = true;
      });
      if (stuck) return result("stuck", "Agent 反复执行相同操作且没有进展，已强制终止。请换一种描述或拆分任务。");
    }
    step = maxSteps;
    return result("max_steps", lastText ? `${lastText}\n\n（已达到最大步数 ${maxSteps}，任务可能未完成）` : `已达到最大步数 ${maxSteps}，任务未完成，请拆分后重试。`);
  } catch (e: any) {
    // 最后的安全网：agent 内部的未预料异常也不能让调用方崩溃
    return result("llm_error", `Agent 内部错误：${e?.message ?? e}`);
  }
}
