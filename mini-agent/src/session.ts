import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runAgent, type AgentResult } from "./agent.js";
import { buildContext } from "./context.js";
import { runFixTask, type FixOpts, type FixResult } from "./fix.js";
import { diagnose, type DiagnoseResult } from "./diagnose.js";
import { ensureManifest, invalidateManifest } from "./probe.js";
import { confirmOps } from "./ui/confirm.js";
import type { ApproveFn } from "./tools/ctx.js";
import type { Workspace } from "./workspace.js";
import { MODEL } from "./config.js";
import {
  type Msg, addNote, compactConversation, saveConversation, loadConversation, clearConversation,
} from "./memory.js";
import { JobManager } from "./tools/jobs.js";
import { McpManager } from "./mcp.js";
import { discoverSkills, skillsBlock } from "./skills.js";
import { type TaskState, emptyState, resetState, loadState, renderPlan } from "./taskstate.js";

/** 向用户提问。signal 触发（Ctrl+C）时应返回 ""，调用方会把空答案当作"拒绝" */
export type Prompter = { ask(question: string, signal?: AbortSignal): Promise<string> };

/**
 * 一个 Session = 一个目录 + 一个模型 + 一份独立的对话/检查点/授权。
 * 所有模块的状态都挂在这里而不是模块级全局，所以可以同时存在多个 Session。
 *
 * 记忆：`messages` 是一条连续的对话（见 memory.ts），ask / diag / fix 每个回合都往同一个数组里追加。
 */
export class Session {
  readonly sessionId = crypto.randomBytes(8).toString("hex");
  model: string;
  /** 会话记忆：完整的 OpenAI messages（含工具调用与结果）。永远原地修改，不要替换这个数组 */
  readonly messages: Msg[] = [];
  /** 计划 + 工作笔记：每一步都注入系统提示，不受历史压缩影响（见 taskstate.ts） */
  readonly state: TaskState = emptyState();
  /** 后台任务（长时间命令）：会话级，跨回合存活，退出时统一终止 */
  readonly jobs = new JobManager();
  /** 外部工具（MCP）连接 */
  readonly mcp = new McpManager();
  /** 最近一次"真正改过文件"的任务的检查点，供 /undo 使用 */
  lastWorkspace: Workspace | null = null;
  /** 用户选过 always 的文件 */
  readonly approved = new Set<string>();

  private _cwd: string;
  private controller: AbortController | null = null;

  constructor(cwd: string, model: string = MODEL, public prompter: Prompter | null = null) {
    this._cwd = path.resolve(cwd);
    this.model = model;
  }

  get cwd(): string { return this._cwd; }
  get busy(): boolean { return this.controller !== null; }

  /** 当前对话里"用户消息"的条数（给界面显示用） */
  get turns(): number { return this.messages.filter((m) => m.role === "user").length; }

  /** 切换目录：对话、检查点、授权都属于旧项目，一并清掉，避免串到新项目 */
  chdir(d: string): string {
    const next = path.resolve(this._cwd, d);
    let ok = false;
    try { ok = fs.statSync(next).isDirectory(); } catch { /* 下面统一报错 */ }
    if (!ok) throw new Error(`不是有效目录：${next}`);
    this._cwd = next;
    this.messages.length = 0;
    resetState(this.state);
    this.lastWorkspace = null;
    this.approved.clear();
    return next;
  }

  /** 中断当前任务；返回是否真的有任务在跑 */
  interrupt(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  private async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controller) throw new Error("上一个任务还在运行");
    const c = new AbortController();
    this.controller = c;
    try {
      // 每个回合开始前：历史太长就先压缩较早的回合（保留最近几个回合的原文）
      await compactConversation(this.messages, this.model, c.signal);
      return await fn(c.signal);
    } finally {
      this.controller = null;
      void saveConversation(this._cwd, this.messages, this.state);   // 落盘，下次启动可 /resume
    }
  }

  private askUser(signal: AbortSignal): ((q: string) => Promise<string>) | null {
    const p = this.prompter;
    return p ? (q) => p.ask(q, signal) : null;
  }

  private approveFn(): ApproveFn | undefined {
    const p = this.prompter;
    if (!p) return undefined;
    return (ops) => confirmOps((q) => p.ask(q, this.controller?.signal), ops);
  }

  /** 技能清单（+ 已连接的外部工具说明）：拼进系统提示 */
  private async extraContext(withMcp: boolean): Promise<string> {
    const skills = await discoverSkills(this._cwd).catch(() => []);
    return [skillsBlock(skills), withMcp ? this.mcp.promptBlock() : ""].filter(Boolean).join("\n\n");
  }

  async context(): Promise<string> { return buildContext(this._cwd, this.model, await this.extraContext(false)); }

  /** 只读问答：工具集里没有写工具 */
  ask(input: string): Promise<AgentResult> {
    return this.run(async (signal) => {
      const ctx = await this.context();
      return runAgent(input, ctx, {
        root: this._cwd, sessionId: this.sessionId, model: this.model, mode: "ask", signal, task: input,
        messages: this.messages, state: this.state, jobs: this.jobs,
      });
    });
  }

  /**
   * 自主执行：模型自己判断是回答、分析还是改代码。改了文件才进入验证/评审闭环；没改就只是一次问答。
   */
  fix(task: string, opts: FixOpts = {}): Promise<FixResult> {
    return this.run(async (signal) => {
      await this.mcp.ensure(this._cwd, this.askUser(signal));
      const res = await runFixTask(task, this._cwd, {
        ...opts, signal, sessionId: this.sessionId, model: this.model,
        approve: this.approveFn(), approved: this.approved, messages: this.messages, state: this.state,
        jobs: this.jobs, mcp: this.mcp, extraContext: await this.extraContext(true),
      });

      if (res.rolledBack) {
        // 文件已经回到修改前，但对话里还留着"我改了 X"：必须告诉模型，否则它会基于不存在的改动继续推理
        addNote(this.messages, `上一个任务失败，我对文件的所有改动已被回滚，文件现在是修改之前的状态。`);
      } else if (res.status === "aborted" && res.changedFiles.length) {
        addNote(this.messages, `用户中断了上一个任务；已做的改动保留在磁盘上：${res.changedFiles.join(", ")}。`);
      }
      // 纯问答回合的 workspace 是空的，不能覆盖上一次真正改动的撤销点
      if (!res.rolledBack && res.changedFiles.length) this.lastWorkspace = res.workspace;
      return res;
    });
  }

  diagnose(task: string): Promise<DiagnoseResult> {
    return this.run((signal) => diagnose(task, this._cwd, {
      model: this.model, sessionId: this.sessionId, signal, messages: this.messages, state: this.state,
    }));
  }

  async probe(): Promise<void> {
    await invalidateManifest(this._cwd);       // 旧实现没有 await：重探可能先于删除执行
    await ensureManifest(this._cwd, this.model);
  }

  /** 撤销最近一次改动；返回被还原的文件 */
  async undo(): Promise<string[] | null> {
    if (!this.lastWorkspace) return null;
    const files = await this.lastWorkspace.rollback();
    this.lastWorkspace = null;
    if (files.length) addNote(this.messages, `用户执行了 /undo，以下文件已还原为改动前的内容：${files.join(", ")}。`);
    void saveConversation(this._cwd, this.messages, this.state);
    return files;
  }

  /** 恢复上次落盘的对话（同一目录）。返回恢复的消息条数，没有则 0 */
  async resume(): Promise<number> {
    const saved = await loadConversation(this._cwd);
    if (!saved) return 0;
    this.messages.length = 0;
    this.messages.push(...saved.messages);
    loadState(this.state, saved.state);
    return saved.messages.length;
  }

  /** /skills */
  async describeSkills(): Promise<string> {
    const skills = await discoverSkills(this._cwd);
    return skills.length
      ? skills.map((s) => `- ${s.name}（${s.source}）：${s.description}${s.verify ? "  [带自动验证]" : ""}`).join("\n")
      : "没有可用技能。把技能放到 .agent/skills/<名字>/SKILL.md 即可。";
  }

  /** /mcp：当前目录的外部工具连接状态；reload 重新读取配置 */
  async describeMcp(reload = false): Promise<string> {
    const ask = this.prompter ? (q: string) => this.prompter!.ask(q) : null;
    if (reload) await this.mcp.reload(this._cwd, ask); else await this.mcp.ensure(this._cwd, ask);
    return `${this.mcp.describe()}${this.mcp.toolCount ? `\n共 ${this.mcp.toolCount} 个外部工具` : ""}`;
  }

  /** /jobs */
  describeJobs(): string {
    const all = this.jobs.list();
    return all.length ? all.map((j) => this.jobs.describe(j)).join("\n") : "没有后台任务。";
  }

  /** 退出前清理：终止后台任务、关闭外部工具进程 */
  dispose() {
    this.jobs.killAll();
    this.mcp.closeAll();
  }

  /** 当前计划与笔记的可读文本（/plan 用） */
  describeState(): string {
    const plan = renderPlan(this.state);
    const parts = [plan ? `计划：\n${plan}` : "（当前没有计划）"];
    if (this.state.notes) parts.push(`笔记：\n${this.state.notes}`);
    return parts.join("\n\n");
  }

  /** 清空对话、计划与笔记（包括磁盘上的落盘） */
  async resetHistory(): Promise<void> {
    this.messages.length = 0;
    resetState(this.state);
    await clearConversation(this._cwd);
  }
}
