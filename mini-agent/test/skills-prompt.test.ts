import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

/**
 * 端到端：用一个假的 OpenAI 兼容服务（等价于 qwen 之类的接口）接住 mini-agent 真正发出的请求，
 * 检查模型"实际看到"了什么——系统提示里的技能清单、use_skill 工具——以及模型调用 use_skill 之后拿到了什么。
 */

type Seen = { system: string; tools: string[]; messages: any[] };
const seen: Seen[] = [];
const script: Array<{ content?: string; tool?: { name: string; args: unknown } }> = [];

const server = http.createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    const msgs: any[] = body.messages ?? [];
    seen.push({
      system: typeof msgs[0]?.content === "string" ? msgs[0].content : "",
      tools: (body.tools ?? []).map((t: any) => t.function?.name),
      messages: msgs,
    });
    const step = script.shift() ?? { content: "ok" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: any, finish: string | null) =>
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (step.tool) {
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }, null));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: step.content }, null));
      res.write(chunk({}, "stop"));
    }
    res.end("data: [DONE]\n\n");
  });
});

let root = "";
let Session: typeof import("../src/session.js").Session;

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  // llm.ts 在 import 时读环境变量：必须先设好再动态 import（每个测试文件是独立进程，不会串）
  process.env.AGENT_BACKEND = "native";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.OPENAI_API_KEY = "test";
  process.env.AGENT_MODEL = "qwen-plus";

  root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-prompt-"));
  const dir = path.join(root, ".agent", "skills", "image-gen");
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"),
    "---\nname: image-gen\ndescription: >\n  根据文字描述生成图片\n  （调用本地 scripts/gen.py）\n---\n步骤：运行 {python} \"{skill_dir}/scripts/gen.py\" \"提示词\"\n");
  fs.writeFileSync(path.join(dir, "scripts", "gen.py"), "print('hi')\n");
  ({ Session } = await import("../src/session.js"));
});

after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

const OPTS = { autoRetry: true, requireConfirm: false, deferBaseline: true } as const;

test("the model is shown the project skill (name + one-line description) and the use_skill tool, in /ask and agent mode", async () => {
  const ses = new Session(root, "qwen-plus", null);
  try {
    seen.length = 0;
    await ses.ask("请生成一张猫的图片");
    await ses.fix("请生成一张猫的图片，.agent 里有生成图片的技能", OPTS);
    assert.ok(seen.length >= 2);
    for (const r of seen) {
      assert.match(r.system, /## 可用技能/, "skills block present");
      assert.match(r.system, /- image-gen：根据文字描述生成图片 （调用本地 scripts\/gen\.py）/, "multi-line description folded into the listing");
      assert.ok(r.tools.includes("use_skill"), "use_skill tool offered");
      assert.match(r.system, /不要回答"没有这个技能"/, "prompt tells the model to check the list before denying a skill");
    }
  } finally { ses.dispose(); }
});

test("use_skill works end to end, even when the model writes the name loosely", async () => {
  const ses = new Session(root, "qwen-plus", null);
  try {
    seen.length = 0;
    script.push({ tool: { name: "use_skill", args: { name: "Image_Gen" } } }, { content: "好的，已按技能步骤处理" });
    const res = await ses.fix("生成一张猫的图片", OPTS);
    assert.equal(res.answer?.includes("已按技能步骤处理"), true);
    assert.equal(seen.length, 2, "tool call, then the final answer");
    const toolMsg = seen[1].messages.filter((m) => m.role === "tool").at(-1);
    assert.match(toolMsg.content, /# 技能：image-gen/);
    assert.match(toolMsg.content, /scripts\/gen\.py/, "skill body with {skill_dir} resolved to the real folder");
    assert.doesNotMatch(toolMsg.content, /\{skill_dir\}/);
  } finally { ses.dispose(); }
});

test("a wrong skill name returns the list WITH descriptions so the model can pick the right one", async () => {
  const ses = new Session(root, "qwen-plus", null);
  try {
    seen.length = 0;
    script.push({ tool: { name: "use_skill", args: { name: "draw-picture" } } }, { content: "换一个" });
    await ses.fix("画一张猫", OPTS);
    const toolMsg = seen[1].messages.filter((m) => m.role === "tool").at(-1);
    assert.match(toolMsg.content, /没有名为 draw-picture 的技能/);
    assert.match(toolMsg.content, /- image-gen：根据文字描述生成图片/, "name + purpose, not just names");
    assert.match(toolMsg.content, /重新调用 use_skill/);
  } finally { ses.dispose(); }
});
