import { runTask } from "./agent.js";
import { buildContext } from "./context.js";
import { runVerify } from "./fix.js";
import { ensureManifest } from "./probe.js";

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
只列出你认为最值得修的 3~5 条。不要提出无法验证的改进项。`;

export type DiagnoseResult = { report: string; hasRealErrors: boolean };

export async function diagnose(task: string, root = process.cwd()): Promise<DiagnoseResult> {
  const manifest = await ensureManifest(root);
  const cmds = manifest.verifyCommands.length ? manifest.verifyCommands : fallbackCmds(manifest.lang);

  // 1. 先跑验证器，拿客观事实
  const outputs: string[] = [];
  for (const cmd of cmds) {
    const v = await runVerify(root, cmd);
    outputs.push(`[${v.ok ? "PASS" : "FAIL"}] ${v.cmd}\n${(v.stderr + v.stdout).slice(0, 4000)}`);
  }
  const verifyOutput = outputs.join("\n") || "(无验证器输出)";
  const hasRealErrors = !/^  $ PASS $  /m.test(verifyOutput);

  // 2. 只读模式让模型分析
  process.env.AGENT_READONLY = "1";
  try {
    const ctx = await buildContext(root);
    const prompt = DIAGNOSE_PROMPT.replace("{verifyOutput}", verifyOutput);
    const report = await runTask(`${prompt}\n\n用户任务：${task}`, ctx);
    return { report, hasRealErrors };
  } finally {
    delete process.env.AGENT_READONLY;
  }
}

function fallbackCmds(lang: string): string[] {
  const map: Record<string, string> = { python: "python -m compileall -q .", go: "go build ./...", rust: "cargo check", java: "mvn compile -q" };
  return map[lang] ? [map[lang]] : [];
}