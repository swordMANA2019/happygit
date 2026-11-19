import type { PptBridge } from "./ppt.js";
import { lintSlide, formatIssues, type Issue } from "./lint.js";
import { applyOps } from "../tools/ppt.js";

/**
 * /watch ppt：用户在 PowerPoint 里手动编辑时的"实时建议"。
 * 不是流式订阅（COM 没有可靠的跨进程变更事件），而是轮询一个很便宜的指纹，变了且稳定下来再检查：
 *   每 POLL_MS 取一次指纹（几十毫秒、不花 token）→ 指纹变了就等它稳定 DEBOUNCE_MS（用户还在拖动/打字时不打扰）
 *   → 对用户当前页跑规则检查（不花 token）→ 只把"新出现"的问题打印出来（同一问题不重复提示）
 *   → 能机械修复的问题可以 /apply 直接执行（不经过模型）。
 * Agent 正在跑任务时不轮询（它自己的修改会走 ppt_edit 的自动检查）。
 */

const POLL_MS = Number(process.env.AGENT_WATCH_POLL_MS) || 1500;
const DEBOUNCE_MS = Number(process.env.AGENT_WATCH_DEBOUNCE_MS) || 3000;
const MAX_ERRORS = 6;

export type WatchHost = {
  ppt: PptBridge;
  cwd: () => string;
  busy: () => boolean;
  print: (s: string) => void;
};

export class PptWatcher {
  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  private lastFp = "";
  private lastSlide = -1;
  private lastChange = 0;
  private linted = "";
  private shown = new Set<string>();
  private errors = 0;
  /** 当前页最新的（warn 以上）问题，编号即 /apply N 的 N */
  issues: Issue[] = [];

  constructor(private host: WatchHost) {}

  get running(): boolean { return this.timer !== null; }

  start(): void {
    if (this.timer) return;
    this.lastFp = ""; this.lastSlide = -1; this.linted = ""; this.shown.clear(); this.errors = 0; this.issues = [];
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 手动触发一次检查（/apply 之后、或测试用）；返回当前页的问题 */
  async checkNow(): Promise<Issue[]> {
    const fp = await this.host.ppt.fingerprint();
    if (!fp.running || !fp.open) { this.issues = []; return []; }
    const sl = await this.host.ppt.dump();
    this.issues = lintSlide(sl).filter((x) => x.severity !== "info");
    this.linted = fp.fp ?? "";
    return this.issues;
  }

  private async tick(): Promise<void> {
    if (this.inflight || this.host.busy()) return;
    this.inflight = true;
    try {
      const fp = await this.host.ppt.fingerprint();
      this.errors = 0;
      if (!fp.running || !fp.open || !fp.fp) { this.lastFp = ""; this.lastSlide = -1; return; }
      const now = Date.now();
      // 第一次看到 / 用户切换了页：只记基线，不提示（否则一开 watch 或翻页就把整页"历史问题"倒出来）。之后在这一页上的改动才触发
      if (fp.slide !== this.lastSlide) {
        this.lastSlide = fp.slide ?? -1; this.lastFp = fp.fp; this.linted = fp.fp;
        await this.baseline();
        return;
      }
      if (fp.fp !== this.lastFp) { this.lastFp = fp.fp; this.lastChange = now; return; }
      if (fp.fp === this.linted || now - this.lastChange < DEBOUNCE_MS) return;

      // 稳定了、且和上次检查时不同：检查当前页
      const sl = await this.host.ppt.dump();
      const all = lintSlide(sl).filter((x) => x.severity !== "info");
      const current = new Set(all.map((x) => x.id));
      const fresh = all.filter((x) => !this.shown.has(x.id));
      this.shown = current;                 // 已解决的问题从集合里消失；以后再出现会重新提示
      this.issues = all;
      this.linted = fp.fp;
      if (fresh.length) {
        const fixable = all.filter((x) => x.fix).length;
        this.host.print(
          `\n🔎 [PowerPoint 第 ${sl.index} 页] 发现 ${fresh.length} 个新问题：\n` +
          formatIssues(fresh, { withFix: true, startAt: all.indexOf(fresh[0]) + 1 }) +
          `\n   ${fixable ? `/apply 自动修复（共 ${fixable} 个可修）；` : ""}或直接告诉我怎么改；/ppt review 让我整体评审这一页`);
      }
    } catch {
      // PowerPoint 正忙（用户在编辑文字/弹出对话框）时 COM 会拒绝调用：安静地跳过这一轮
      if (++this.errors >= MAX_ERRORS) {
        this.stop();
        this.host.print("\n[watch] 连续多次无法读取 PowerPoint，已停止监视（/watch ppt 可重新开启）。");
      }
    } finally {
      this.inflight = false;
    }
  }

  /** 开启时的基线：记下当前页已有的问题（不打印），之后只提示新增的 */
  private async baseline(): Promise<void> {
    try {
      const sl = await this.host.ppt.dump();
      const all = lintSlide(sl).filter((x) => x.severity !== "info");
      this.shown = new Set(all.map((x) => x.id));
      this.issues = all;
    } catch { /* 下一轮再说 */ }
  }

  /**
   * /apply：执行问题自带的修复（不经过模型）。spec 为空或 all = 当前页所有可修复的；"1,3" = 按最近一次提示里的编号。
   */
  async apply(spec: string): Promise<string> {
    let list: Issue[];
    const s = spec.trim().toLowerCase();
    if (!s || s === "all") {
      list = await this.checkNow();
    } else {
      const nums = s.split(/[,，\s]+/).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
      if (!this.issues.length) return "没有待处理的建议编号（先 /watch ppt 等待提示，或直接 /apply 修复当前页所有可修复的问题）。";
      list = nums.map((n) => this.issues[n - 1]).filter(Boolean);
      if (!list.length) return `编号无效；当前有 ${this.issues.length} 条建议。`;
    }
    const fixable = list.filter((x) => x.fix);
    if (!fixable.length) return list.length ? "这些问题需要人工判断，没有可自动执行的修复；可以直接告诉我想怎么改。" : "当前页没有发现问题。";
    const seen = new Set<string>();
    const ops: unknown[] = [];
    for (const x of fixable) for (const op of x.fix!.ops) { const k = JSON.stringify(op); if (!seen.has(k)) { seen.add(k); ops.push(op); } }
    const r = await applyOps(this.host.ppt, this.host.cwd(), ops);
    const after = await this.checkNow().catch(() => []);
    this.shown = new Set(after.map((x) => x.id));
    const head = r.ok ? `已执行 ${r.applied.length} 个修复操作` : `已执行 ${r.applied.length}/${ops.length} 个操作，第 ${r.failedAt} 个失败：${r.error}`;
    return `${head}${r.backup ? `（修改前已备份：${r.backup}）` : ""}。PowerPoint 里可 Ctrl+Z 撤销。` +
      (after.length ? `\n仍有 ${after.length} 个问题：\n${formatIssues(after)}` : "\n当前页规则检查通过。");
  }
}
