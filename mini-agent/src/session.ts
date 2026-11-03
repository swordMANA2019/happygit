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
      void saveConversation(this._cwd, this.messages);   // 落盘，下次启动可 /resume
    }
  }

  private approveFn(): ApproveFn | undefined {
    const p = this.prompter;
    if (!p) return undefined;
    return (ops) => confirmOps((q) => p.ask(q, this.controller?.signal), ops);
  }

  context(): Promise<string> { return buildContext(this._cwd, this.model); }

  /** 只读问答：工具集里没有写工具 */
  ask(input: string): Promise<AgentResult> {
    return this.run(async (signal) => {
      const ctx = await this.context();
      return runAgent(input, ctx, {
        root: this._cwd, sessionId: this.sessionId, model: this.model, mode: "ask", signal, task: input,
        messages: this.messages,
      });
    });
  }

  /**
   * 自主执行：模型自己判断是回答、分析还是改代码。改了文件才进入验证/评审闭环；没改就只是一次问答。
   */
  fix(task: string, opts: FixOpts = {}): Promise<FixResult> {
    return this.run(async (signal) => {
      const res = await runFixTask(task, this._cwd, {
        ...opts, signal, sessionId: this.sessionId, model: this.model,
        approve: this.approveFn(), approved: this.approved, messages: this.messages,
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
      model: this.model, sessionId: this.sessionId, signal, messages: this.messages,
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
    void saveConversation(this._cwd, this.messages);
    return files;
  }

  /** 恢复上次落盘的对话（同一目录）。返回恢复的消息条数，没有则 0 */
  async resume(): Promise<number> {
    const saved = await loadConversation(this._cwd);
    if (!saved) return 0;
    this.messages.length = 0;
    this.messages.push(...saved);
    return saved.length;
  }

  /** 清空对话（包括磁盘上的落盘） */
  async resetHistory(): Promise<void> {
    this.messages.length = 0;
    await clearConversation(this._cwd);
  }
}
