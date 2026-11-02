import path from "node:path";
import crypto from "node:crypto";
import { runTask } from "./agent.js";
import { buildContext } from "./context.js";
import { runFixTask, type FixOpts, type FixResult } from "./fix.js";
import { diagnose, type DiagnoseResult } from "./diagnose.js";
import { ensureManifest, invalidateManifest } from "./probe.js";
import { MODEL } from "./config.js";

export class Session {
  public readonly sessionId = crypto.randomBytes(8).toString("hex");

  constructor(private _cwd: string, public model: string = MODEL) {}

  get cwd(): string { return this._cwd; }

  chdir(d: string): string {
    this._cwd = path.resolve(this._cwd, d);
    return this._cwd;
  }

  context(): Promise<string> { return buildContext(this._cwd); }
  ask(task: string, context: string): Promise<string> {
    return runTask(task, context, this._cwd, this.sessionId, this.model); 
  }
  fix(task: string, opts: FixOpts = {}): Promise<FixResult> {
    return runFixTask(task, this._cwd,
      { ...opts, sessionId: this.sessionId, model: this.model});
    }
  diagnose(task: string): Promise<DiagnoseResult> {
    return diagnose(task, this._cwd,this.sessionId, this.model);
  }
  probe(): Promise<void> {
    invalidateManifest(this._cwd);
    return ensureManifest(this._cwd).then(() => {});
  }
}