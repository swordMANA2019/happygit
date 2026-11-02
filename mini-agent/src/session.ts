import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runAgent, type AgentResult } from "./agent.js";
import { buildContext } from "./context.js";
import { runFixTask, type FixOpts, type FixResult } from "./fix.js";
import { diagnose, type DiagnoseResult } from "./diagnose.js";
import { route } from "./router.js";
import { ensureManifest, invalidateManifest } from "./probe.js";
import { confirmOps } from "./ui/confirm.js";
import type { ApproveFn } from "./tools/ctx.js";
import type { Workspace } from "./workspace.js";
import { MODEL } from "./config.js";

/** 向用户提问。signal 触发（Ctrl+C）时应返回 ""，调用方会把空答案当作"拒绝" */
export type Prompter = { ask(question: string, signal?: AbortSignal): Promise<string> };

/**
 * 一个 Session = 一个目录 + 一个模型 + 一份独立的历史/检查点/授权。
 * 所有模块的状态都挂在这里而不是模块级全局，所以可以同时存在多个 Session。
 */
export class Session {
  readonly sessionId = crypto.randomBytes(8).toString("hex");
  model: string;
  history: string[] = [];
  /** 最近一次任务的检查点，供 /undo 使用 */
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

  /** 切换目录：历史、检查点、授权都属于旧项目，一并清掉，避免串到新项目 */
  chdir(d: string): string {
    const next = path.resolve(this._cwd, d);
    let ok = false;
    try { ok = fs.statSync(next).isDirectory(); } catch { /* 下面统一报错 */ }
    if (!ok) throw new Error(`不是有效目录：${next}`);
    this._cwd = next;
    this.history = [];
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
    try { return await fn(c.signal); } finally { this.controller = null; }
  }

  private approveFn(): ApproveFn | undefined {
    const p = this.prompter;
    if (!p) return undefined;
    return (ops) => confirmOps((q) => p.ask(q, this.controller?.signal), ops);
  }

  context(): Promise<string> { return buildContext(this._cwd, this.model); }

  route(input: string) { return route(input, this.model); }

  /** 只读问答：工具集里没有写工具 */
  ask(input: string): Promise<AgentResult> {
    return this.run(async (signal) => {
      const ctx = await this.context();
      const memo = this.history.length ? `此前对话摘要：\n${this.history.join("\n---\n")}\n\n` : "";
      const r = await runAgent(memo + input, ctx, {
        root: this._cwd, sessionId: this.sessionId, model: this.model, mode: "ask", signal,
      });
      if (r.status === "done") {
        this.history.push(`用户：${input}\n助手：${r.text}`.slice(0, 2000));
        if (this.history.length > 5) this.history.shift();
      }
      return r;
    });
  }

  fix(task: string, opts: FixOpts = {}): Promise<FixResult> {
    return this.run(async (signal) => {
      const res = await runFixTask(task, this._cwd, {
        ...opts, signal, sessionId: this.sessionId, model: this.model,
        approve: this.approveFn(), approved: this.approved,
      });
      this.lastWorkspace = res.rolledBack ? null : res.workspace;
      return res;
    });
  }

  diagnose(task: string): Promise<DiagnoseResult> {
    return this.run((signal) => diagnose(task, this._cwd, { model: this.model, sessionId: this.sessionId, signal }));
  }

  async probe(): Promise<void> {
    await invalidateManifest(this._cwd);       // 旧实现没有 await：重探可能先于删除执行
    await ensureManifest(this._cwd, this.model);
  }

  /** 撤销最近一次任务；返回被还原的文件 */
  async undo(): Promise<string[] | null> {
    if (!this.lastWorkspace) return null;
    const files = await this.lastWorkspace.rollback();
    this.lastWorkspace = null;
    return files;
  }

  resetHistory() { this.history = []; }
}
