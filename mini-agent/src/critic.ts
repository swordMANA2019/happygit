// src/critic.ts（无 zod 版，其余不变）
import { client} from "./llm.js";
import { MODEL } from "./config.js";

export type CriticResult = {
  pass: boolean;
  score: number;
  fatal: boolean;
  findings: string[];
  suggestion: string;
  detail: string;
};

function parse(raw: unknown): CriticResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.pass !== "boolean") return null;
  const score = typeof o.score === "number" ? Math.max(0, Math.min(1, o.score)) : 0.5;
  const findings = Array.isArray(o.findings) ? o.findings.filter((x): x is string => typeof x === "string") : [];
  return {
    pass: o.pass,
    score,
    fatal: Boolean(o.fatal),
    findings,
    suggestion: typeof o.suggestion === "string" ? o.suggestion : "",
    detail: findings.join("\n"),
  };
}

const PROMPT = `你是独立代码评审员，不参与修改。只依据给出的材料判断。
输出严格 JSON：{"pass":bool,"score":0~1,"fatal":bool,"findings":[],"suggestion":""}
fatal=true 当且仅当：删除或跳过测试、注释掉报错、新增 any/unsafe、吞异常、引入 TODO 占位、弱化安全校验、降低断言阈值。`;

export type CriticCtx = { task: string; rubric: string; diff: string; lastShellOutput: string };

export async function runCritic(ctx: CriticCtx, model: string = MODEL): Promise<CriticResult> {
  const body = PROMPT + `\n任务：${ctx.task}\n验收：${ctx.rubric || "(无)"}\ndiff：${ctx.diff || "(无)"}\n验证输出：${ctx.lastShellOutput.slice(0, 3000)}`;
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await client.chat.completions.create({
        model, messages: [{ role: "user", content: body }], temperature: 0,
        response_format: { type: "json_object" },
      });
      const r = parse(JSON.parse(resp.choices[0].message.content ?? "{}"));
      if (r) return r;
    } catch {}
  }
  return { pass: false, score: 0.5, fatal: false, findings: ["评审输出解析失败"], suggestion: "请人工确认本次变更", detail: "critic parse failed" };
}

export function shouldSkipCritic(diff: string): boolean {
  const lines = diff.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
  return lines.filter((l) => !/^[+-]\s*(\/\/|#|\/\*|\*|\s*$)/.test(l)).length < 5;
}