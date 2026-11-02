// src/router.ts
import { client } from "./llm.js";
import { MODEL } from "./config.js";
import { classify } from "./intent.js"; // 降级兜底，留着

export type Mode = "ask" | "edit" | "fix" | "clarify";

const PROMPT = `你是意图路由器，只做分类，不执行、不回答。输出严格 JSON：
{"mode":"ask"|"edit"|"fix"|"clarify","reason":"一句话说明","missing":["还缺的关键信息"]}

判定：
- ask：只需解释/阅读/分析/对比/给建议，不产生代码变更。包括"为什么报错""这段什么意思""有没有更好的写法"。
- edit：用户明确要求改代码/加功能/重构，目标明确可直接动手，且不涉及故障。
- fix：涉及报错、失败、缺陷、bug、回归、性能劣化——需要先定位证据再修复，必须走验证闭环。
- clarify：缺少关键信息（无错误信息/无目标文件/无期望行为/多个可能方向），必须先反问一句。

示例：
"帮我看看这段代码有什么问题" → ask（只读分析，不要擅自改）
"帮我修好这个报错" → fix
"给 utils.ts 加个超时重试" → edit
"测试挂了" → fix
"这个项目怎么跑起来" → ask
"优化一下" → clarify（missing: ["优化目标：速度/可读性/内存/覆盖率"])`;

export async function route(input: string, model: string = MODEL): Promise<{ mode: Mode; reason: string; missing: string[] }> {
  try {
    const resp = await client.chat.completions.create({
      model,                     // 建议换成便宜的小模型，如 gpt-4o-mini / qwen-turbo
      messages: [{ role: "system", content: PROMPT }, { role: "user", content: input }],
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const obj = JSON.parse(resp.choices[0].message.content ?? "{}");
    const m = ["ask", "edit", "fix", "clarify"].includes(obj.mode) ? obj.mode : "ask";
    return { mode: m as Mode, reason: String(obj.reason ?? ""), missing: Array.isArray(obj.missing) ? obj.missing : [] };
  } catch {
    // API 挂了才走关键词，不抛错打断对话
    const { mode } = classify(input);
    return { mode, reason: "(router failed, fallback to keywords)", missing: [] };
  }
}