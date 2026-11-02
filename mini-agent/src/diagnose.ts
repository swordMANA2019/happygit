import { runAgent } from "./agent.js";
import { buildContext } from "./context.js";
import { runVerify } from "./fix.js";
import { ensureManifest } from "./probe.js";
import { MODEL } from "./config.js";

const DIAGNOSE_PROMPT = `你是代码诊断员，当前为只读模式，不得修改任何文件。
结合以下真实验证输出和项目代码，输出一份缺陷报告。

验证器输出：
{verifyOutput}

输出格式（Markdown）：
## 确认的缺陷（有验证器证据）

| 文件 | 行 | 现象 | 置信度 |
...
## 疑似问题（需人工确认）
...
## 建议修复顺序
只列出你认为最值得修的 3~5 条。不要提出无法验证的改进项。

注意：如果某个验证器标注为【环境问题】或【超时】，那不是代码缺陷，请只在报告开头一句话说明"该验证器不可用及原因"，不要把它当作缺陷。`;

export type DiagnoseResult = { report: string; hasRealErrors: boolean };
export type DiagnoseOpts = { model?: string; sessionId: string; signal?: AbortSignal };

export async function diagnose(task: string, root: string, opts: DiagnoseOpts): Promise<DiagnoseResult> {
  const model = opts.model ?? MODEL;
  const manifest = await ensureManifest(root, model);
  const cmds = manifest.verifyCommands;

  // 1. 先跑验证器，拿客观事实
  const outputs: string[] = [];
  let hasRealErrors = false;
  for (const cmd of cmds) {
    const v = await runVerify(root, cmd, opts.signal);
    // 只有"代码层失败"才算真实缺陷；验证器没跑起来（环境/超时）要单独标注
    const label = v.ok ? "PASS" : v.kind === "code" ? "FAIL" : v.kind === "timeout" ? "超时·非代码缺陷" : "环境问题·非代码缺陷";
    if (!v.ok && v.kind === "code") hasRealErrors = true;
    outputs.push(`[${label}] ${v.cmd}${v.ok || v.kind === "code" ? "" : `（${v.reason}）`}\n${(v.stderr + v.stdout).slice(0, 4000)}`);
  }
  const verifyOutput = outputs.join("\n") || "(没有可用的验证器)";

  // 2. 只读模式让模型分析：mode:"ask" 的工具集里根本没有写工具
  const ctx = await buildContext(root, model);
  const prompt = DIAGNOSE_PROMPT.replace("{verifyOutput}", () => verifyOutput);
  const r = await runAgent(`${prompt}\n\n用户任务：${task}`, ctx, {
    root, sessionId: opts.sessionId, model, mode: "ask", signal: opts.signal,
  });
  const report = r.status === "done" ? r.text : `[诊断未完成：${r.status}] ${r.text}`;
  return { report, hasRealErrors };
}
