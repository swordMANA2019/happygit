import { fmtSecs } from "./util.js";

/**
 * 一次任务的耗时统计：回答"时间到底花在哪了"。
 * 阶段（互斥，加起来 = 总用时）：准备 / 主循环 / 验证 / 评审 / 自测 / 收尾
 * 横切计数（和阶段重叠）：模型调用次数与耗时、发送/输出字符数、各工具耗时
 * 同一时刻只有一个任务在跑，所以用一个模块级的"当前统计"，开始任务时 resetStats()。
 */

export type Phase = "准备" | "主循环" | "验证" | "评审" | "自测" | "收尾";

class RunStats {
  readonly t0 = Date.now();
  private phase: Phase = "准备";
  private phaseStart = Date.now();
  readonly phases = new Map<Phase, number>();

  llmCalls = 0;
  llmMs = 0;
  llmMaxMs = 0;
  sentChars = 0;
  outChars = 0;
  thinkChars = 0;
  readonly tools = new Map<string, { n: number; ms: number }>();

  /** 切换阶段，返回之前的阶段（方便"临时切过去、做完切回来"） */
  enter(p: Phase): Phase {
    const now = Date.now();
    const prev = this.phase;
    this.phases.set(prev, (this.phases.get(prev) ?? 0) + now - this.phaseStart);
    this.phase = p;
    this.phaseStart = now;
    return prev;
  }

  llm(ms: number, sent: number, out: number, think: number) {
    this.llmCalls++;
    this.llmMs += ms;
    this.llmMaxMs = Math.max(this.llmMaxMs, ms);
    this.sentChars += sent;
    this.outChars += out;
    this.thinkChars += think;
  }

  tool(name: string, ms: number) {
    const t = this.tools.get(name) ?? { n: 0, ms: 0 };
    t.n++;
    t.ms += ms;
    this.tools.set(name, t);
  }

  total() { return Date.now() - this.t0; }

  render(): string {
    this.enter(this.phase);                       // 结算当前阶段
    const total = this.total();
    const phases = [...this.phases.entries()].filter(([, ms]) => ms >= 500).map(([p, ms]) => `${p} ${fmtSecs(ms)}`).join(" | ");
    const lines = [`⏱ 总用时 ${fmtSecs(total)}${phases ? `  （${phases}）` : ""}`];
    if (this.llmCalls) {
      const avg = this.llmMs / this.llmCalls;
      lines.push(
        `  模型调用 ${this.llmCalls} 次，共 ${fmtSecs(this.llmMs)}（平均 ${fmtSecs(avg)}，最慢 ${fmtSecs(this.llmMaxMs)}）；` +
        `平均每次发送约 ${Math.round(this.sentChars / this.llmCalls / 1000)}k 字符，平均输出约 ${Math.round(this.outChars / this.llmCalls)} 字符` +
        (this.thinkChars ? `，思考共 ${Math.round(this.thinkChars / 1000)}k 字符` : ""),
      );
    }
    const toolMs = [...this.tools.values()].reduce((s, t) => s + t.ms, 0);
    if (this.tools.size) {
      const top = [...this.tools.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5)
        .map(([n, t]) => `${n} ${fmtSecs(t.ms)}×${t.n}`).join(" · ");
      lines.push(`  工具执行（累计）${fmtSecs(toolMs)}：${top}`);
    }
    return lines.join("\n");
  }
}

let current = new RunStats();
export const resetStats = () => { current = new RunStats(); return current; };
export const stats = () => current;
