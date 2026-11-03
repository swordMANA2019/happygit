import { spawn } from "node:child_process";
import { classifyFailure } from "../errors.js";
import { decodeOutput, killTree, checkDangerous } from "./shell.js";
import { stripAnsi, truncateMiddle } from "../util.js";

/**
 * 后台任务（长时间命令）。
 *
 * 为什么需要：安装 PyTorch、训练模型、跑对接/模拟、大型构建……动辄几分钟到几小时。
 * 旧实现把"超过 60 秒"当成失败：杀掉进程、返回"超时"，模型只能放弃。
 * 做得好的 Agent（Cursor 的终端、Claude Code 的后台 shell）都是：
 *   - 命令先前台等一会儿；到点还没结束就【转入后台继续跑】，把 job id 和已有输出还给模型；
 *   - 模型用 job_output 轮询进度（可以"等待 N 秒"，不会空转烧步数）、用 stop_job 终止；
 *   - "还没跑完"不是失败。
 */

export type JobStatus = "running" | "exited" | "killed";

export type Job = {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  status: JobStatus;
  code: number | null;
  spawnError?: string;
  /** 上次 job_output 读到的位置（按清理后的文本长度） */
  cursor: number;
  out: Buffer[];
  err: Buffer[];
  bytes: number;
  pid?: number;
};

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** 把进度条之类的 \r 覆盖输出折叠成最终一行，并去掉 ANSI */
export function cleanOutput(s: string): string {
  return stripAnsi(s)
    .split("\n")
    .map((line) => {
      const i = line.lastIndexOf("\r");
      return i >= 0 && i < line.length - 1 ? line.slice(i + 1) : line.replace(/\r$/, "");
    })
    .join("\n");
}

const textOf = (j: Job) => {
  const o = decodeOutput(j.out);
  const e = decodeOutput(j.err);
  return cleanOutput(o + (e ? (o && !o.endsWith("\n") ? "\n" : "") + e : ""));
};

export class JobManager {
  private jobs = new Map<string, Job>();
  private waiters = new Map<string, Set<() => void>>();
  private seq = 0;

  constructor() {
    // 正常退出时不留孤儿进程（Windows 的 taskkill 是异步 spawn，exit 事件里也能发出去）
    process.on("exit", () => this.killAll());
  }

  list(): Job[] { return [...this.jobs.values()]; }
  get(id: string): Job | undefined { return this.jobs.get(id); }

  start(command: string, opts: { cwd: string; env?: Record<string, string> }): Job {
    const job: Job = {
      id: `job${++this.seq}`, command, cwd: opts.cwd, startedAt: Date.now(),
      status: "running", code: null, cursor: 0, out: [], err: [], bytes: 0,
    };
    this.jobs.set(job.id, job);

    const done = (code: number | null, status: JobStatus) => {
      if (job.status !== "running") return;
      job.status = status;
      job.code = code;
      job.endedAt = Date.now();
      for (const w of this.waiters.get(job.id) ?? []) w();
      this.waiters.delete(job.id);
    };

    try {
      const child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0",
          // 让 Python 工具立刻输出、pip 不刷进度条：轮询时才看得到真实进度
          PYTHONUNBUFFERED: "1", PIP_PROGRESS_BAR: "off", PIP_DISABLE_PIP_VERSION_CHECK: "1",
          ...opts.env,
        },
      });
      job.pid = child.pid;
      const push = (arr: Buffer[]) => (d: Buffer) => {
        if (job.bytes < MAX_BUFFER_BYTES) { arr.push(d); job.bytes += d.length; }
      };
      child.stdout?.on("data", push(job.out));
      child.stderr?.on("data", push(job.err));
      child.on("error", (e) => { job.spawnError = e.message; job.err.push(Buffer.from(`\n${e.message}`)); done(null, "exited"); });
      child.on("close", (code) => done(code, "exited"));
    } catch (e: any) {
      job.spawnError = e?.message ?? String(e);
      job.err.push(Buffer.from(job.spawnError!));
      done(null, "exited");
    }
    return job;
  }

  /**
   * 等到任务结束 / 超过 ms / 被中断。每 15 秒向 stderr 打一行心跳，用户知道没有卡死。
   * 返回时任务可能仍在运行。
   */
  async wait(job: Job, ms: number, signal?: AbortSignal): Promise<void> {
    if (job.status !== "running") return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let beat: NodeJS.Timeout | undefined;
      const finish = () => {
        clearTimeout(timer);
        clearInterval(beat);
        signal?.removeEventListener("abort", finish);
        this.waiters.get(job.id)?.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, ms);
      beat = setInterval(() => {
        const tail = textOf(job).trim().split("\n").pop()?.slice(0, 100) ?? "";
        console.error(`[job] ${job.id} 运行中 ${Math.round((Date.now() - job.startedAt) / 1000)}s${tail ? ` | ${tail}` : ""}`);
      }, 15_000);
      signal?.addEventListener("abort", finish, { once: true });
      let set = this.waiters.get(job.id);
      if (!set) this.waiters.set(job.id, (set = new Set()));
      set.add(finish);
      if (job.status !== "running" || signal?.aborted) finish();
    });
  }

  /** 读取自上次以来的新输出（并推进游标）；输出过长时保留头尾 */
  readNew(job: Job, cap = 12_000): string {
    const all = textOf(job);
    const fresh = all.slice(job.cursor);
    job.cursor = all.length;
    return truncateMiddle(fresh.trim(), cap);
  }

  stop(job: Job): boolean {
    if (job.status !== "running") return false;
    job.status = "killed";
    killTree(job.pid);
    job.endedAt = Date.now();
    for (const w of [...(this.waiters.get(job.id) ?? [])]) w();
    this.waiters.delete(job.id);
    return true;
  }

  killAll() {
    for (const j of this.jobs.values()) if (j.status === "running") this.stop(j);
  }

  describe(j: Job): string {
    const secs = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
    const state =
      j.status === "running" ? `运行中（已 ${secs}s）` :
      j.status === "killed"  ? `已终止（运行了 ${secs}s）` :
      j.code === 0           ? `已完成，退出码 0（用时 ${secs}s）` :
                               `已结束，退出码 ${j.code ?? "无"}（用时 ${secs}s）`;
    return `${j.id}: ${state} | ${j.command.slice(0, 120)}`;
  }

  /** 已结束且失败时，附上失败性质（环境/代码），沿用和前台命令一致的提示 */
  failureNote(j: Job): string {
    if (j.status !== "exited" || j.code === 0) return "";
    const f = classifyFailure({
      code: j.code, stdout: decodeOutput(j.out), stderr: decodeOutput(j.err), spawnError: j.spawnError,
    });
    return f.kind === "env"
      ? `\n[环境问题：${f.reason}] 这不是代码缺陷，请不要通过修改业务代码来规避；换用其它可用命令，或在总结中说明该环境限制。`
      : "";
  }
}

/* ---- 供 Agent 工具层调用：返回给模型看的观察文本，永不抛异常 ---- */

const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 10 * 60_000;

export async function runCommandJob(
  jm: JobManager,
  command: string,
  opts: { cwd: string; timeoutMs?: number; background?: boolean; signal?: AbortSignal; env?: Record<string, string> },
): Promise<string> {
  const danger = checkDangerous(command);
  if (danger) return `[已拒绝] 该命令被安全策略拦截：${danger}。如确有必要，请改用更安全的方式，或在最终回复中说明并让用户手动执行。`;

  const job = jm.start(command, { cwd: opts.cwd, env: opts.env });
  const waitMs = opts.background ? 2000 : Math.min(Math.max(opts.timeoutMs ?? DEFAULT_WAIT_MS, 1000), MAX_WAIT_MS);
  await jm.wait(job, waitMs, opts.signal);

  if (opts.signal?.aborted) {
    jm.stop(job);
    return `[已中断] 用户中断了任务，命令已终止。已有输出：\n${jm.readNew(job)}`.trim();
  }

  if (job.status === "running") {
    const partial = jm.readNew(job);
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    return [
      opts.background
        ? `[已在后台启动 ${job.id}]`
        : `[仍在运行，已转入后台 ${job.id}（前台已等待 ${secs}s）。这【不是失败】，进程还在继续。]`,
      partial ? `到目前为止的输出：\n${partial}` : "（暂时没有输出）",
      `下一步：用 job_output(job_id="${job.id}", wait_ms=60000) 等待并查看进度，直到状态变为"已完成"后再继续后续步骤；需要终止用 stop_job。` +
      `不要因为命令耗时长就放弃任务或向用户报告失败。`,
    ].join("\n");
  }

  // 已结束：格式与旧的前台命令一致
  const body = jm.readNew(job, 16_000);
  if (job.status === "exited" && job.code === 0) return body || "(命令执行成功，无输出)";
  const head = job.status === "killed" ? "[命令已被终止]" : `[命令失败，退出码 ${job.code ?? "无"}]`;
  return `${head}${jm.failureNote(job)}\n${body}`.trim();
}

export async function jobOutput(jm: JobManager, id: unknown, waitMs: unknown, signal?: AbortSignal): Promise<string> {
  const job = typeof id === "string" ? jm.get(id) : undefined;
  if (!job) return `[工具错误] 没有这个任务：${String(id)}。现有任务：${jm.list().map((j) => j.id).join(", ") || "无"}`;

  const ms = typeof waitMs === "number" ? Math.min(Math.max(waitMs, 0), MAX_WAIT_MS) : 30_000;
  if (ms > 0) await jm.wait(job, ms, signal);
  const fresh = jm.readNew(job);
  const status = jm.describe(job);

  if (job.status === "running") {
    return `${status}\n${fresh ? `新增输出：\n${fresh}` : "（自上次查看以来没有新输出）"}\n` +
           `任务仍在进行中。请继续 job_output(job_id="${job.id}", wait_ms=60000) 等待，不要放弃。`;
  }
  const failed = job.status === "exited" && job.code !== 0;
  return `${status}${failed ? jm.failureNote(job) : ""}\n${fresh ? `新增输出：\n${fresh}` : "（没有新增输出）"}`;
}

export function stopJob(jm: JobManager, id: unknown): string {
  const job = typeof id === "string" ? jm.get(id) : undefined;
  if (!job) return `[工具错误] 没有这个任务：${String(id)}`;
  return jm.stop(job) ? `已终止 ${job.id}` : `${job.id} 已经结束，无需终止。`;
}

export function listJobs(jm: JobManager): string {
  const all = jm.list();
  return all.length ? all.map((j) => jm.describe(j)).join("\n") : "没有后台任务。";
}
