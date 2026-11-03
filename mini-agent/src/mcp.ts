import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import OpenAI from "openai";
import { autoAllowed } from "./ui/confirm.js";
import { killTree } from "./tools/shell.js";

/**
 * MCP（Model Context Protocol）客户端：把外部工具接进 Agent 的标准方式。
 * 药物设计工具包、日历、数据库、浏览器……只要有人把它包成 MCP 服务器，这里配置一行就能用，
 * Agent 核心代码不用改。实现的是 stdio 传输（子进程 + 按行分隔的 JSON-RPC 2.0）：
 *   initialize → notifications/initialized → tools/list → tools/call
 *
 * 配置文件格式与 Cursor 的 mcp.json 相同：
 *   { "mcpServers": { "名字": { "command": "...", "args": ["..."], "env": { "K": "V" } } } }
 * 读取位置：~/.mini-agent/mcp.json（用户级，信任）、<项目>/.agent/mcp.json、<项目>/.cursor/mcp.json（项目级）。
 *
 * 安全：项目级配置意味着"打开一个项目就会执行它指定的命令"，所以每个项目级服务器首次启动前必须经用户确认
 * （--yes / AGENT_AUTO_APPROVE=1 可放行）；非交互环境一律不启动。
 *
 * 工具暴露：数量不多时每个工具直接暴露（模型调用最准）；超过 DIRECT_LIMIT 个就改成
 * mcp_search_tools + mcp_call 两个通用入口，避免几十上百个 schema 撑爆提示词（对应 Cursor 的"工具按需加载"）。
 */

type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

const DIRECT_LIMIT = 20;
const CALL_TIMEOUT_MS = Number(process.env.AGENT_MCP_TIMEOUT_MS ?? 120_000);
const START_TIMEOUT_MS = Number(process.env.AGENT_MCP_START_TIMEOUT_MS ?? 30_000);

type ServerCfg = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
type McpTool = { name: string; description?: string; inputSchema?: any };
type Source = "user" | "project";

export const isMcpToolName = (n: string) => n.startsWith("mcp__") || n === "mcp_call" || n === "mcp_search_tools";

/* ---------------------------------------------------------------------------
 * 单个服务器连接
 * ------------------------------------------------------------------------- */

class McpClient {
  tools: McpTool[] = [];
  private proc?: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  stderrTail = "";

  constructor(readonly name: string, private cfg: ServerCfg, private cwd: string) {}

  async start(): Promise<void> {
    const win = process.platform === "win32";
    const quote = (a: string) => (win && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    this.proc = spawn(win ? quote(this.cfg.command) : this.cfg.command, (this.cfg.args ?? []).map(quote), {
      cwd: this.cfg.cwd ?? this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: win,                      // npx / uvx 在 Windows 上是 .cmd，需要 shell
      windowsHide: true,
      detached: !win,
      env: { ...process.env, ...this.cfg.env },
    });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
    this.proc.stderr!.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-1500); });
    this.proc.on("error", (e) => this.failAll(new Error(`无法启动：${e.message}`)));
    this.proc.on("close", (code) => this.failAll(new Error(`服务器已退出（退出码 ${code}）${this.stderrTail ? `：${this.stderrTail.trim().slice(-300)}` : ""}`)));

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mini-agent", version: "0.1.0" },
    }, START_TIMEOUT_MS);
    this.notify("notifications/initialized");

    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {}, START_TIMEOUT_MS);
      this.tools.push(...((r?.tools ?? []) as McpTool[]));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }          // 非 JSON 的日志行直接忽略
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        // 服务器发来的请求（采样、roots 等）：本客户端不支持，礼貌拒绝，避免服务器一直等
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported by mini-agent" } });
      }
    }
  }

  private write(obj: unknown) {
    try { this.proc?.stdin?.write(JSON.stringify(obj) + "\n"); } catch { /* 进程已死，由 close 事件统一处理 */ }
  }

  private notify(method: string, params?: unknown) { this.write({ jsonrpc: "2.0", method, params }); }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      const onAbort = () => { clearTimeout(timer); this.pending.delete(id); this.notify("notifications/cancelled", { requestId: id }); reject(new Error("已中断")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(v); },
        reject: (e) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(e); },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async callTool(tool: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const r = await this.request("tools/call", { name: tool, arguments: args ?? {} }, CALL_TIMEOUT_MS, signal);
    const parts: string[] = [];
    for (const c of r?.content ?? []) {
      if (c.type === "text") parts.push(c.text);
      else if (c.type === "image") parts.push("[图片结果，已省略]");
      else if (c.type === "resource") parts.push(c.resource?.text ?? JSON.stringify(c.resource ?? c).slice(0, 2000));
      else parts.push(JSON.stringify(c).slice(0, 2000));
    }
    if (r?.structuredContent && parts.length === 0) parts.push(JSON.stringify(r.structuredContent));
    const text = parts.join("\n").trim() || "(工具没有返回内容)";
    return r?.isError ? `[MCP 工具报错] ${text}` : text;
  }

  close() {
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
    killTree(this.proc?.pid);
  }
}

/* ---------------------------------------------------------------------------
 * 管理器：加载配置、确认、暴露工具、分发调用
 * ------------------------------------------------------------------------- */

export type AskFn = (question: string) => Promise<string>;
type Entry = { server: string; tool: McpTool; client: McpClient };
type ServerStatus = { name: string; source: Source; ok: boolean; tools: number; note?: string };

async function readConfig(file: string): Promise<Record<string, ServerCfg>> {
  try {
    const j = JSON.parse(await fs.readFile(file, "utf-8"));
    const servers = j?.mcpServers ?? j?.servers ?? {};
    const out: Record<string, ServerCfg> = {};
    for (const [k, v] of Object.entries<any>(servers)) {
      if (v && typeof v.command === "string") out[k] = { command: v.command, args: v.args, env: v.env, cwd: v.cwd };
    }
    return out;
  } catch { return {}; }
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export class McpManager {
  private clients: McpClient[] = [];
  private index = new Map<string, Entry>();
  private loadedRoot: string | null = null;
  private declined = new Set<string>();
  status: ServerStatus[] = [];

  constructor() { process.on("exit", () => this.closeAll()); }

  /** 只在目录变化或首次使用时加载；已加载则立即返回 */
  async ensure(root: string, ask: AskFn | null): Promise<void> {
    if (this.loadedRoot === root) return;
    this.closeAll();
    this.loadedRoot = root;

    const layers: Array<[Source, Record<string, ServerCfg>]> = [
      ["user", await readConfig(path.join(os.homedir(), ".mini-agent", "mcp.json"))],
      ["project", await readConfig(path.join(root, ".cursor", "mcp.json"))],
      ["project", await readConfig(path.join(root, ".agent", "mcp.json"))],
    ];
    const merged = new Map<string, { cfg: ServerCfg; source: Source }>();
    for (const [source, servers] of layers) for (const [name, cfg] of Object.entries(servers)) merged.set(name, { cfg, source });

    // 串行：确认提示共用一个 readline，不能同时问多个问题
    const startOne = async (name: string, { cfg, source }: { cfg: ServerCfg; source: Source }) => {
      const st: ServerStatus = { name, source, ok: false, tools: 0 };
      this.status.push(st);
      if (source === "project" && !autoAllowed()) {
        if (!ask) { st.note = "项目级 MCP 服务器需要用户确认，非交互环境未启动"; return; }
        if (this.declined.has(`${root}|${name}`)) { st.note = "用户已拒绝"; return; }
        const ans = (await ask(`\n项目配置了 MCP 服务器「${name}」，将执行：${cfg.command} ${(cfg.args ?? []).join(" ")}\n启动并允许 Agent 使用它的工具？[y/N] `)).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") { this.declined.add(`${root}|${name}`); st.note = "用户拒绝启动"; return; }
      }
      const client = new McpClient(name, cfg, root);
      try {
        await client.start();
        this.clients.push(client);
        st.ok = true;
        st.tools = client.tools.length;
        for (const t of client.tools) this.register(name, t, client);
        console.error(`[mcp] ${name}：已连接，${client.tools.length} 个工具`);
      } catch (e: any) {
        client.close();
        st.note = e?.message ?? String(e);
        console.error(`[mcp] ${name}：启动失败 — ${st.note}`);
      }
    };
    for (const [name, v] of merged) await startOne(name, v);
  }

  /** 重新读取配置并重启所有服务器（/mcp reload） */
  async reload(root: string, ask: AskFn | null): Promise<void> {
    this.declined.clear();
    this.closeAll();
    await this.ensure(root, ask);
  }

  private register(server: string, tool: McpTool, client: McpClient) {
    let name = `mcp__${safe(server)}__${safe(tool.name)}`.slice(0, 64);
    for (let i = 2; this.index.has(name); i++) name = `${name.slice(0, 60)}_${i}`;
    this.index.set(name, { server, tool, client });
  }

  get toolCount(): number { return this.index.size; }

  /** 暴露给模型的工具定义 */
  toolDefs(): Tool[] {
    if (this.index.size === 0) return [];
    if (this.index.size > DIRECT_LIMIT) {
      return [
        { type: "function", function: {
            name: "mcp_search_tools",
            description: "在已连接的 MCP 外部工具中搜索（按名称/描述关键词），返回工具名、说明和参数 schema。需要外部工具时先搜索再用 mcp_call 调用。",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
        { type: "function", function: {
            name: "mcp_call",
            description: "调用一个 MCP 外部工具。name 用 mcp_search_tools 返回的完整名称，arguments 按其 schema 填写。",
            parameters: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] } } },
      ];
    }
    return [...this.index].map(([name, e]) => ({
      type: "function" as const,
      function: {
        name,
        description: `[MCP:${e.server}] ${e.tool.description ?? e.tool.name}`.slice(0, 1000),
        parameters: e.tool.inputSchema?.type === "object" ? e.tool.inputSchema : { type: "object", properties: {} },
      },
    }));
  }

  /** 系统提示里的外部工具说明 */
  promptBlock(): string {
    if (this.index.size === 0) return "";
    const servers = this.status.filter((s) => s.ok).map((s) => `${s.name}（${s.tools}）`).join("、");
    return this.index.size > DIRECT_LIMIT
      ? `## 外部工具（MCP）\n已连接服务器：${servers}，共 ${this.index.size} 个工具。需要时先 mcp_search_tools 搜索，再用 mcp_call 调用。`
      : `## 外部工具（MCP）\n已连接服务器：${servers}。它们的工具以 mcp__<服务器>__<工具> 命名，可直接调用；耗时很长的外部任务请优先使用它们自带的"提交 / 查询进度"类工具。`;
  }

  search(query: unknown): string {
    const q = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [...this.index].filter(([name, e]) => {
      const hay = `${name} ${e.tool.description ?? ""}`.toLowerCase();
      return q.length === 0 || q.some((w) => hay.includes(w));
    }).slice(0, 12);
    if (hits.length === 0) return `没有匹配 "${query}" 的外部工具。共 ${this.index.size} 个，可换个关键词。`;
    return hits.map(([name, e], i) => {
      const schema = i < 5 ? `\n  参数：${JSON.stringify(e.tool.inputSchema ?? {}).slice(0, 700)}` : "";
      return `- ${name}：${(e.tool.description ?? "").slice(0, 200)}${schema}`;
    }).join("\n");
  }

  /** 调用：永不抛异常 */
  async call(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const e = this.index.get(name);
    if (!e) return `[工具错误] 没有这个外部工具：${name}。可用 mcp_search_tools 查找。`;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return `[参数错误] ${name} 的 arguments 必须是 JSON 对象。`;
    }
    try {
      return await e.client.callTool(e.tool.name, args, signal);
    } catch (err: any) {
      return `[MCP 调用失败] ${name}：${err?.message ?? err}`;
    }
  }

  describe(): string {
    if (this.status.length === 0) return "没有配置 MCP 服务器（~/.mini-agent/mcp.json、.agent/mcp.json 或 .cursor/mcp.json）。";
    return this.status.map((s) =>
      `${s.ok ? "✓" : "✗"} ${s.name}（${s.source === "user" ? "用户级" : "项目级"}）${s.ok ? `：${s.tools} 个工具` : `：${s.note ?? "未启动"}`}`).join("\n");
  }

  closeAll() {
    for (const c of this.clients) c.close();
    this.clients = [];
    this.index.clear();
    this.status = [];
    this.loadedRoot = null;
  }
}
