import { EventEmitter } from "node:events";
import type { PptApi } from "./bridge.js";
import { lintSlide, formatIssues, type Issue } from "./lint.js";
import { applyOps, collectFixOps } from "./ops.js";

/**
 * 实时建议：用户在 PowerPoint 里手动编辑时，持续检查当前页。
 * 不是流式订阅（COM 没有可靠的跨进程变更事件），而是轮询一个很便宜的指纹，变了且稳定下来再检查：
 *   每 pollMs 取一次指纹（几十毫秒、不花 token）→ 指纹变了就等它稳定 debounceMs（用户还在拖动/打字时不打扰）
 *   → 对用户当前页跑规则检查 → 只把"新出现"的问题通过 "issues" 事件发出去（同一问题不重复提示）
 *   → 能机械修复的问题可以 apply() 直接执行（不经过模型）。
 * 用户翻到另一页时只记基线、不提示（否则一翻页就把那页的"历史问题"当成新问题）。
 *
 * 事件：
 *   "issues"  (e: { slide: number; fresh: Issue[]; all: Issue[] })  有新问题
 *   "stopped" (reason: "errors")                                      连续多次读不到 PowerPoint，已自动停止
 */

export type WatcherOptions = {
  ppt: PptApi;
  /** 修复前备份文件放哪里（可以是函数：宿主切换项目目录后目录会变） */
  backupDir: string | (() => string);
  /** 返回 true 时跳过本轮（例如 agent 正在自己改文稿） */
  busy?: () => boolean;
  /** 轮询间隔，默认 1500ms */
  pollMs?: number;
  /** 稳定多久才检查，默认 3000ms */
  debounceMs?: number;
  /** 连续失败多少次后自动停止，默认 6 */
  maxErrors?: number;
  /** 提示里包含的最低严重度，默认 warn（不含 info） */
  includeInfo?: boolean;
};

export type WatchIssuesEvent = { slide: number; fresh: Issue[]; all: Issue[] };

export type ApplyResult =
  | { status: "no_suggestions" }                                  // 用编号但还没有任何建议
  | { status: "bad_number"; total: number }
  | { status: "clean" }                                           // 当前页没有问题
  | { status: "no_fix"; total: number }                           // 有问题但都需要人工判断
  | { status: "applied"; ok: boolean; applied: number; ops: number; failedAt?: number; error?: string; backup?: string | null; remaining: Issue[] };

export class PptWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  private lastFp = "";
  private lastSlide = -1;
  private lastChange = 0;
  private linted = "";
  private shown = new Set<string>();
  private errors = 0;
  private readonly o: { ppt: PptApi; backupDir: string | (() => string); busy?: () => boolean; pollMs: number; debounceMs: number; maxErrors: number; includeInfo: boolean };
  /** 当前页最新的问题，编号即 apply("N") 的 N */
  issues: Issue[] = [];

  constructor(opts: WatcherOptions) {
    super();
    this.o = {
      ppt: opts.ppt, backupDir: opts.backupDir, busy: opts.busy,
      pollMs: opts.pollMs ?? 1500, debounceMs: opts.debounceMs ?? 3000, maxErrors: opts.maxErrors ?? 6, includeInfo: opts.includeInfo ?? false,
    };
  }

  get running(): boolean { return this.timer !== null; }

  start(): void {
    if (this.timer) return;
    this.lastFp = ""; this.lastSlide = -1; this.linted = ""; this.shown.clear(); this.errors = 0; this.issues = [];
    this.timer = setInterval(() => { void this.tick(); }, this.o.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private lint(sl: Parameters<typeof lintSlide>[0]): Issue[] {
    const all = lintSlide(sl);
    return this.o.includeInfo ? all : all.filter((x) => x.severity !== "info");
  }

  /** 手动触发一次检查；返回当前页的问题（也会更新 issues，供 apply 的编号使用） */
  async checkNow(): Promise<Issue[]> {
    const fp = await this.o.ppt.fingerprint();
    if (!fp.running || !fp.open) { this.issues = []; return []; }
    const sl = await this.o.ppt.dump();
    this.issues = this.lint(sl);
    this.linted = fp.fp ?? "";
    return this.issues;
  }

  private async tick(): Promise<void> {
    if (this.inflight || this.o.busy?.()) return;
    this.inflight = true;
    try {
      const fp = await this.o.ppt.fingerprint();
      this.errors = 0;
      if (!fp.running || !fp.open || !fp.fp) { this.lastFp = ""; this.lastSlide = -1; return; }
      const now = Date.now();
      // 第一次看到 / 用户切换了页：只记基线，不提示。之后在这一页上的改动才触发
      if (fp.slide !== this.lastSlide) {
        this.lastSlide = fp.slide ?? -1; this.lastFp = fp.fp; this.linted = fp.fp;
        await this.baseline();
        return;
      }
      if (fp.fp !== this.lastFp) { this.lastFp = fp.fp; this.lastChange = now; return; }
      if (fp.fp === this.linted || now - this.lastChange < this.o.debounceMs) return;

      // 稳定了、且和上次检查时不同：检查当前页
      const sl = await this.o.ppt.dump();
      const all = this.lint(sl);
      const current = new Set(all.map((x) => x.id));
      const fresh = all.filter((x) => !this.shown.has(x.id));
      this.shown = current;                 // 已解决的问题从集合里消失；以后再出现会重新提示
      this.issues = all;
      this.linted = fp.fp;
      if (fresh.length) this.emit("issues", { slide: sl.index, fresh, all } satisfies WatchIssuesEvent);
    } catch {
      // PowerPoint 正忙（用户在编辑文字/弹出对话框）时 COM 会拒绝调用：安静地跳过这一轮
      if (++this.errors >= this.o.maxErrors) {
        this.stop();
        this.emit("stopped", "errors");
      }
    } finally {
      this.inflight = false;
    }
  }

  /** 开启时/翻页时的基线：记下当前页已有的问题（不提示），之后只提示新增的 */
  private async baseline(): Promise<void> {
    try {
      const sl = await this.o.ppt.dump();
      const all = this.lint(sl);
      this.shown = new Set(all.map((x) => x.id));
      this.issues = all;
    } catch { /* 下一轮再说 */ }
  }

  /**
   * 执行问题自带的修复（不经过模型）。spec 为空或 "all" = 当前页所有可修复的；"1,3" = 按最近一次提示里的编号。
   */
  async apply(spec = ""): Promise<ApplyResult> {
    let list: Issue[];
    const s = spec.trim().toLowerCase();
    if (!s || s === "all") {
      list = await this.checkNow();
    } else {
      const nums = s.split(/[,，\s]+/).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
      if (!this.issues.length) return { status: "no_suggestions" };
      list = nums.map((n) => this.issues[n - 1]).filter(Boolean);
      if (!list.length) return { status: "bad_number", total: this.issues.length };
    }
    const { ops } = collectFixOps(list);
    if (!ops.length) return list.length ? { status: "no_fix", total: list.length } : { status: "clean" };
    const dir = typeof this.o.backupDir === "function" ? this.o.backupDir() : this.o.backupDir;
    const r = await applyOps(this.o.ppt, dir, ops);
    const remaining = await this.checkNow().catch(() => [] as Issue[]);
    this.shown = new Set(remaining.map((x) => x.id));
    return { status: "applied", ok: r.ok, applied: r.applied.length, ops: ops.length, failedAt: r.failedAt, error: r.error, backup: r.backup, remaining };
  }
}

/** apply() 结果的文字版（中文，给终端/聊天直接显示） */
export function formatApplyResult(r: ApplyResult): string {
  switch (r.status) {
    case "no_suggestions": return "没有待处理的建议编号（先 /watch ppt 等待提示，或直接 /apply 修复当前页所有可修复的问题）。";
    case "bad_number": return `编号无效；当前有 ${r.total} 条建议。`;
    case "clean": return "当前页没有发现问题。";
    case "no_fix": return "这些问题需要人工判断，没有可自动执行的修复；可以直接告诉我想怎么改。";
    case "applied": {
      const head = r.ok ? `已执行 ${r.applied} 个修复操作` : `已执行 ${r.applied}/${r.ops} 个操作，第 ${r.failedAt} 个失败：${r.error}`;
      return `${head}${r.backup ? `（修改前已备份：${r.backup}）` : ""}。PowerPoint 里可 Ctrl+Z 撤销。` +
        (r.remaining.length ? `\n仍有 ${r.remaining.length} 个问题：\n${formatIssues(r.remaining)}` : "\n当前页规则检查通过。");
    }
  }
}

/** "issues" 事件的文字版（终端提示用） */
export function formatWatchEvent(e: WatchIssuesEvent): string {
  const fixable = e.all.filter((x) => x.fix).length;
  return `🔎 [PowerPoint 第 ${e.slide} 页] 发现 ${e.fresh.length} 个新问题：\n` +
    formatIssues(e.fresh, { withFix: true, startAt: e.all.indexOf(e.fresh[0]) + 1 }) +
    `\n   ${fixable ? `/apply 自动修复（共 ${fixable} 个可修）；` : ""}或直接告诉我怎么改；/ppt review 让我整体评审这一页`;
}
