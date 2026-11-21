import fs from "node:fs/promises";
import path from "node:path";
import { HEARTBEAT_MS, normalizeCursorModel } from "../config.js";
import { emitTrace, uiContext } from "../trace.js";
import { Workspace } from "../workspace.js";
import { captureBaseline, recordChanges, type TrackResult } from "./tracker.js";

/**
 * Cursor 后端：把一个回合交给 Cursor Agent（@cursor/sdk，本地运行时）。
 *
 * 分工：Cursor Agent 自己读/写/搜索/跑命令/验证；mini-agent 负责
 *   - 终端交互、会话、Ctrl+C 中断（→ run.cancel()）
 *   - 改动追踪：任务前后比对，写进 Workspace，所以 /undo、/diff 照常可用（见 tracker.ts）
 *   - ask 模式只读：创建 agent 时只给读类工具（allowlist）
 *   - PowerPoint：以 customTools 形式提供（调用同一套 @mini-agent/ppt-sdk 处理函数）
 * mini-agent 自己的 路径防护 / 风险确认 / 验证 / 评审 在这个后端不参与——生效的是 Cursor 自己的权限与沙箱设置。
 *
 * SDK 通过结构化接口使用（下面的 *Like），所以：@cursor/sdk 是可选依赖、测试可以注入假实现。
 */

/* ---- 我们用到的那一小部分 SDK 接口（与 @cursor/sdk 的 d.ts 对齐） ---- */
export interface CursorRunResultLike {
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: { message: string; code?: string };
  durationMs?: number;
  usage?: Record<string, unknown>;
}
export interface CursorRunLike {
  readonly id: string;
  stream(): AsyncGenerator<any, void>;
  wait(): Promise<CursorRunResultLike>;
  cancel(): Promise<void>;
}
export interface CursorAgentLike {
  readonly agentId: string;
  send(message: string, options?: Record<string, unknown>): Promise<CursorRunLike>;
  close(): void;
}
export interface CursorSdkLike {
  Agent: {
    create(options: Record<string, unknown>): Promise<CursorAgentLike>;
    resume(agentId: string, options: Record<string, unknown>): Promise<CursorAgentLike>;
  };
}

export async function loadCursorSdk(): Promise<CursorSdkLike> {
  try {
    return (await import("@cursor/sdk")) as unknown as CursorSdkLike;
  } catch (e: any) {
    throw new Error(
      `无法加载 @cursor/sdk（${e?.message ?? e}）。它是可选依赖，Cursor 后端需要它（Node >= 22.13）：在 mini-agent 目录运行 npm install @cursor/sdk。`,
    );
  }
}

/** ask 模式给 Cursor Agent 的工具白名单：只有读/搜索类 + mcp（只承载我们按只读过滤过的 PowerPoint 自定义工具） */
export const READ_ONLY_TOOLS = ["read", "grep", "glob", "ls", "semSearch", "readLints", "webSearch", "webFetch", "readTodos", "mcp"];

/** AGENT_CURSOR_ASK_TOOLS=read,grep,glob,ls,mcp 可覆盖白名单（SDK 拒绝某个名字时，报错信息里会列出有效名字） */
export function askTools(): string[] {
  const raw = process.env.AGENT_CURSOR_ASK_TOOLS;
  const list = raw ? raw.split(/[,\s]+/).filter(Boolean) : [];
  return list.length ? list : READ_ONLY_TOOLS;
}

/**
 * @cursor/sdk 会往终端打印带时间戳的 INFO 日志（如 "12:43:53.108 INFO  Resolved the fallback encoding…"），目前没有公开的关闭开关。
 * Cursor 回合期间过滤掉【整块都是】这种 INFO/DEBUG/TRACE 行的输出；WARN/ERROR 和其它所有输出照常显示。AGENT_CURSOR_SDK_LOGS=1 关闭过滤。
 */
const SDK_LOG_LINE = /^\d{2}:\d{2}:\d{2}\.\d{3} (INFO|DEBUG|TRACE)\s/;
let muteDepth = 0;
let restoreMute: (() => void) | null = null;

function installMute() {
  const patched: Array<[NodeJS.WriteStream, typeof process.stdout.write, typeof process.stdout.write]> = [];
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write;
    const wrapper = function (this: unknown, chunk: any, ...rest: any[]) {
      const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null;
      if (s !== null) {
        const lines = s.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length && lines.every((l) => SDK_LOG_LINE.test(l))) {
          const cb = rest.find((a) => typeof a === "function");
          if (cb) cb();
          return true;
        }
      }
      return (orig as any).call(stream, chunk, ...rest);
    } as typeof process.stdout.write;
    stream.write = wrapper;
    patched.push([stream, orig, wrapper]);
  }
  return () => { for (const [stream, orig, wrapper] of patched) if (stream.write === wrapper) stream.write = orig; };
}

export async function muteSdkLogs<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.AGENT_CURSOR_SDK_LOGS === "1") return fn();
  if (muteDepth++ === 0) restoreMute = installMute();
  try { return await fn(); }
  finally { if (--muteDepth === 0) { restoreMute?.(); restoreMute = null; } }
}

export type CursorMode = "agent" | "ask";

export type CursorRunOpts = {
  root: string;
  model: string;
  mode: CursorMode;
  prompt: string;
  signal?: AbortSignal;
  /** 本回合提供给 Cursor Agent 的自定义工具（PowerPoint）；省略 = 没有 */
  customTools?: Record<string, unknown>;
  /** 进度输出（工具调用、心跳）；默认写 stderr */
  log?: (line: string) => void;
};

export type CursorTurn = {
  status: "finished" | "error" | "cancelled";
  /** 最终回答 */
  text: string;
  error?: string;
  durationMs: number;
  toolCalls: number;
  agentId: string;
  usage?: Record<string, unknown>;
  /** 本回合的改动（journal 已填好；rollback() 即 /undo） */
  workspace: Workspace;
  tracking: TrackResult;
};

type Opts = { sdk?: CursorSdkLike; apiKey?: string };

const SETTINGS_ENV = "AGENT_CURSOR_SETTINGS";
/** AGENT_CURSOR_SETTINGS=project（默认）| user,project | all | none */
function settingSources(): string[] {
  const raw = (process.env[SETTINGS_ENV] ?? "project").trim().toLowerCase();
  if (raw === "none" || raw === "") return [];
  return raw.split(/[,\s]+/).filter(Boolean);
}

/** 把工具调用参数压成一行：优先显示路径/命令这类最有信息量的字段 */
export function briefArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args.replace(/\s+/g, " ").slice(0, 100);
  if (typeof args !== "object") return String(args);
  const a = args as Record<string, unknown>;
  for (const k of ["path", "target_file", "file_path", "filePath", "command", "pattern", "query", "url", "glob_pattern"]) {
    if (typeof a[k] === "string" && a[k]) return String(a[k]).replace(/\s+/g, " ").slice(0, 100);
  }
  return JSON.stringify(a).slice(0, 100);
}

function authHint(msg: string, hasKey: boolean): string {
  const looksAuth = /api[\s_-]?key|auth|unauthor|401|403|forbidden|login|credential/i.test(msg);
  if (!looksAuth && hasKey) return "";
  return hasKey
    ? "\n提示：请确认 CURSOR_API_KEY 有效（用户 API Key：cursor.com/dashboard/integrations；或团队 service-account key。团队 Admin API Key 不支持）。"
    : "\n提示：没有设置 CURSOR_API_KEY。到 cursor.com/dashboard/integrations 创建用户 API Key，然后 set CURSOR_API_KEY=cursor_...（Admin API 的 key 不能用）。";
}

export class CursorBackend {
  private agent: CursorAgentLike | null = null;
  private agentRoot = "";
  private agentMode: CursorMode | null = null;
  private agentId: string | null = null;
  private sdk: CursorSdkLike | null;
  private readonly apiKey: string | undefined;
  /** 本进程里已完成的回合数 */
  turns = 0;

  constructor(opts: Opts = {}) {
    this.sdk = opts.sdk ?? null;
    this.apiKey = opts.apiKey ?? (process.env.CURSOR_API_KEY || undefined);
  }

  get currentAgentId(): string | null { return this.agentId; }

  private stateFile(root: string) { return path.join(root, ".agent", "cursor-agent.json"); }

  /** /resume：沿用上次在这个目录里的 Cursor agent（对话上下文由 Cursor 保存）。返回是否找到 */
  async restore(root: string): Promise<boolean> {
    try {
      const s = JSON.parse(await fs.readFile(this.stateFile(root), "utf8"));
      if (typeof s?.agentId !== "string" || !s.agentId) return false;
      this.drop();
      this.agentId = s.agentId;
      return true;
    } catch { return false; }
  }

  private async persist(root: string) {
    if (!this.agentId) return;
    try {
      await fs.mkdir(path.dirname(this.stateFile(root)), { recursive: true });
      await fs.writeFile(this.stateFile(root), JSON.stringify({ agentId: this.agentId, ts: Date.now() }));
    } catch { /* 落盘失败只影响 /resume */ }
  }

  /** 关闭当前 agent 句柄（对话保留在 Cursor 的存储里，agentId 仍可 resume） */
  private closeHandle() {
    try { this.agent?.close(); } catch { /* ignore */ }
    this.agent = null;
    this.agentMode = null;
  }

  /** 丢弃整个会话（/reset、/cd）：下个回合新建 agent */
  drop() {
    this.closeHandle();
    this.agentId = null;
    this.agentRoot = "";
    this.turns = 0;
  }

  dispose() { this.closeHandle(); }

  private async ensureAgent(root: string, mode: CursorMode, model: string): Promise<CursorAgentLike> {
    if (this.agent && this.agentRoot === root && this.agentMode === mode) return this.agent;
    this.sdk ??= await loadCursorSdk();

    const local: Record<string, unknown> = { cwd: root, settingSources: settingSources() };
    if (process.env.AGENT_CURSOR_SANDBOX === "1") local.sandboxOptions = { enabled: true };
    const options: Record<string, unknown> = { apiKey: this.apiKey, model: { id: model }, local };
    // tools 不会随 agent 持久化：ask 模式每次创建/恢复都要带上白名单
    if (mode === "ask") options.tools = askTools();

    // 同一个目录里换模式（agent ↔ ask）：关闭句柄，用同一个 agentId 恢复，对话上下文不丢
    const resumeId = this.agentRoot === root || !this.agentRoot ? this.agentId : null;
    this.closeHandle();
    const agent = resumeId
      ? await this.sdk.Agent.resume(resumeId, options)
      : await this.sdk.Agent.create({ ...options, name: `mini-agent ${path.basename(root)}`.slice(0, 60) });
    this.agent = agent;
    this.agentRoot = root;
    this.agentMode = mode;
    this.agentId = agent.agentId;
    await this.persist(root);
    return agent;
  }

  run(o: CursorRunOpts): Promise<CursorTurn> {
    return muteSdkLogs(() => this.runTurn(o));
  }

  private async runTurn(o: CursorRunOpts): Promise<CursorTurn> {
    const log = o.log ?? ((l: string) => console.error(l));
    const model = normalizeCursorModel(o.model);
    const ws = new Workspace(o.root);
    const t0 = Date.now();
    const done = (p: Partial<CursorTurn> & Pick<CursorTurn, "status">, tracking: TrackResult): CursorTurn => ({
      text: "", durationMs: Date.now() - t0, toolCalls: 0, agentId: this.agentId ?? "", workspace: ws, tracking, ...p,
    });
    const noTrack: TrackResult = { complete: true, unrecoverable: [] };

    if (o.signal?.aborted) return done({ status: "cancelled" }, noTrack);

    // agent 模式存内容（可 /undo）；ask 模式只存 mtime:size，用来发现"本不该发生的改动"
    const baseline = await captureBaseline(o.root, o.mode === "agent");

    let agent: CursorAgentLike;
    try {
      agent = await this.ensureAgent(o.root, o.mode, model);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      throw new Error(`[cursor] 无法启动 Cursor Agent：${msg}${authHint(msg, !!this.apiKey)}`);
    }

    let run: CursorRunLike;
    try {
      run = await agent.send(o.prompt, {
        model: { id: model },
        ...(o.customTools && Object.keys(o.customTools).length ? { local: { customTools: o.customTools } } : {}),
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      throw new Error(`[cursor] 发送任务失败：${msg}${authHint(msg, !!this.apiKey)}`);
    }
    log(`[cursor] ${model} 运行中（${o.mode === "ask" ? "只读" : "可读写"}；Ctrl+C 中断）…`);

    const onAbort = () => { void run.cancel().catch(() => {}); };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.signal?.aborted) onAbort();

    let lastText = "";
    let toolCalls = 0;
    let streamError: string | undefined;
    const seen = new Set<string>();
    let lastOut = Date.now();
    const hb = setInterval(() => {
      if (Date.now() - lastOut >= HEARTBEAT_MS * 2) {
        log(`[cursor] 仍在运行…（${Math.round((Date.now() - t0) / 1000)}s）`);
        lastOut = Date.now();
      }
    }, HEARTBEAT_MS);

    // 有界面时：思考 / 动作 / 观察 作为结构化的 ReAct 事件交给界面（折叠显示，同时写后端日志）；没有界面（终端）保持原来的单行进度
    const ui = !o.log && uiContext.getStore() !== undefined;
    const asText = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
    const finished = new Set<string>();
    let step = 0;

    // 思考是一段一段流式到达的：同一段思考用同一个 id，增量攒成 ~80ms 一批再交给界面，界面里就是"一块文字在原地长出来"，
    // 而不是每个词一条记录。遇到非 thinking 事件（工具调用 / 回答）或流结束，这一段思考就算结束。
    let thoughtId: string | null = null;
    let pending = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let thoughtSeq = 0;
    const flushThought = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (thoughtId && pending) { emitTrace({ kind: "thought", step, id: thoughtId, text: pending, append: true }); pending = ""; }
    };
    const endThought = () => {
      if (!thoughtId) return;
      flushThought();
      emitTrace({ kind: "thought", step, id: thoughtId, text: "", done: true });
      thoughtId = null;
    };
    try {
      for await (const ev of run.stream()) {
        lastOut = Date.now();
        if (ev?.type !== "thinking") endThought();
        if (ev?.type === "assistant") {
          const t = (ev.message?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
          if (t.trim()) lastText = t;
        } else if (ev?.type === "thinking") {
          if (ui && typeof ev.text === "string" && ev.text) {
            if (!thoughtId) { thoughtId = `th${++thoughtSeq}`; step++; }
            pending += ev.text;
            if (!flushTimer) flushTimer = setTimeout(flushThought, 80);
          }
        } else if (ev?.type === "tool_call") {
          const id = String(ev.call_id ?? "");
          const name = String(ev.name ?? "tool");
          const status = String(ev.status ?? "");
          if (status === "running") {
            if (!seen.has(id)) { seen.add(id); toolCalls++; }
            const args = briefArgs(ev.args);
            const line = `▸ ${name}${args ? ` ${args}` : ""}`;
            if (ui) emitTrace({ kind: "action", step: ++step, id, name, text: asText(ev.args) || args });
            else log(line);
          } else if (status === "completed" || status === "error") {
            if (finished.has(id)) continue;
            finished.add(id);
            if (ui) {
              emitTrace({ kind: "observation", step, id, name, text: status, ok: status === "completed" });
            } else log(status === "error" ? `✗ ${name}` : `✓ ${name}`);
          }
        }
      }
    } catch (e: any) {
      streamError = String(e?.message ?? e);
    }
    endThought();

    let res: CursorRunResultLike;
    try {
      res = await run.wait();
    } catch (e: any) {
      res = { status: "error", error: { message: streamError ?? String(e?.message ?? e) } };
    } finally {
      clearInterval(hb);
      o.signal?.removeEventListener("abort", onAbort);
    }
    if (streamError && res.status === "finished") res = { ...res, status: "error", error: { message: streamError } };

    const tracking = await recordChanges(baseline, ws);
    this.turns++;
    const errMsg = res.error?.message;
    return done({
      status: res.status,
      text: (res.result ?? lastText ?? "").trim() || lastText.trim(),
      error: errMsg ? errMsg + (res.status === "error" ? authHint(errMsg, !!this.apiKey) : "") : undefined,
      durationMs: res.durationMs ?? Date.now() - t0,
      toolCalls,
      usage: res.usage,
    }, tracking);
  }
}
