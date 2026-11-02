import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { client } from "./llm.js";
import { runTask } from "./agent.js";
import { buildContext } from "./context.js";
import { MAX_RETRIES, ERROR_DIGEST } from "./config.js";
import { ensureManifest } from "./probe.js";
import { runCritic, shouldSkipCritic } from "./critic.js";
import { execAsyncPromised } from "./tools/shell.js";
import {
  classify,
  groupOps,
  proposalId,
  diffSummary,
  type FileOp,
  type Proposal,
} from "./proposal.js";
import { confirmTerminal, autoAllowed } from "./ui/confirm.js";
import { setAllowed, clearAllowed, resolvePath } from "./guard.js";

const execAsync = promisify(exec);

/* ---- git ---- */

export async function gitCheckpoint(root: string, label: string): Promise<string> {
  const name = `agent/${label}-${Date.now()}`;
  await execAsync("git add -A", { cwd: root });
  await execAsync('git commit -m "checkpoint"', { cwd: root }).catch(() => {});
  await execAsync(`git branch -f ${name}`, { cwd: root });
  return name;
}

export async function gitRollback(root: string, ref: string): Promise<void> {
  await execAsync("git reset --hard HEAD", { cwd: root });
  await execAsync("git clean -fd", { cwd: root }).catch(() => {});
  await execAsync(`git checkout ${ref} -- .`, { cwd: root });
}

async function gitDiff(root: string): Promise<string> {
  try {
    const { stdout } = await execAsync("git diff HEAD", { cwd: root, maxBuffer: 5 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

/* ---- 验证 ---- */

export type VerifyResult = { ok: boolean; stdout: string; stderr: string; cmd: string };

export async function runVerify(root: string, cmd: string): Promise<VerifyResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: root,
      timeout: 90_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return { ok: true, stdout, stderr, cmd };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e), cmd };
  }
}

function fallbackCmd(lang: string): string {
  return ({ python: "python -m compileall -q .", go: "go build ./...", rust: "cargo check", java: "mvn compile -q" } as Record<string, string>)[lang] ?? "echo 'no verifier'";
}

function digest(text: string, max = ERROR_DIGEST): string {
  const t = text.replace(/\x1b\[[0-9;]*m/g, "");
  return t.length <= max ? t : t.slice(0, max) + "\n...(truncated)";
}

/* ---- 主循环 ---- */

export type FixOpts = {
  autoRetry?: boolean;
  requireConfirm?: boolean;
  sessionId?: string,
  model?:string
};
export type FixResult = {
  status: "fixed" | "failed" | "denied";
  attempts: number;
  log: string
};

export async function runFixTask(
  task: string,
  root: string,
  opts: FixOpts = {}
): Promise<FixResult> {
  const absRoot = path.resolve(root);
  const { autoRetry = true} = opts;
  const maxRetries = autoRetry ? MAX_RETRIES : 1;

  try { await fs.access(absRoot, fs.constants.R_OK | fs.constants.W_OK); }
  catch { throw new Error(`工作目录不可读写：${absRoot}`); }
  
  try { await execAsync("git rev-parse --git-dir", { cwd: absRoot }); }
  catch {
    throw new Error(`不是 git 仓库（无法建立检查点）：${absRoot}\n请先 git init 或 cd 到仓库根目录。`);
  }

  const manifest = await ensureManifest(absRoot);
  const override = process.env.AGENT_VERIFY_CMD;
  const cmds = override ? [override] : manifest.verifyCommands.length ? manifest.verifyCommands : [fallbackCmd(manifest.lang)];

  console.error(`[fix] cwd=${absRoot} lang=${manifest.lang} cmds=[${cmds.join(", ")}]`);

  const checkpoint = await gitCheckpoint(absRoot, "before-fix");
  const attemptLog: string[] = [];
  let currentTask = task;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ctx = await buildContext(absRoot);

    // 1) 让模型产出结构化提案
    const plan = await proposePlan(currentTask, ctx, absRoot, opts.model ?? "gpt-4o-mini");
    const ops = plan.files.map((f) => classify(absRoot, currentTask, ctx, f));

    // 2) 路径不确定 → 先纠错，不花 token 执行
    const pathHints = ops.filter((f) => f.resolved.status === "candidate" || f.resolved.status === "notfound" || f.resolved.status === "outside");
    if (pathHints.length && attempt < maxRetries) {
      const feedback = pathHints.map((f) => `${f.path}: ${f.resolved.note}`).join("\n");
      currentTask = `路径有误，请按以下提示修正后再改代码：\n${feedback}`;
      attemptLog.push(`[guard] path hints: ${feedback}`);
      continue;
    }

    // 3) 分组：确定的自动，不确定的弹窗
    const { auto, ask } = groupOps(ops);
    for (const f of auto) {
      await applyOp(absRoot, f);
      console.error(`[✓] auto ${f.path} ${diffSummary(f)}`);
    }
    if (ask.length) {
      ask.forEach((f) => console.error(`[${f.risk}] ${f.path} ← ${f.reason} | ${f.resolved.note}`));
      const ok = autoAllowed() || (await confirmTerminal(ask));
      if (!ok) {
        attemptLog.push(`[denied] ${ask.map((f) => f.path).join(", ")}`);
        await gitRollback(absRoot, checkpoint);
        return { status: "denied", attempts: attempt, log: attemptLog.join("\n") };
      }
      for (const f of ask) await applyOp(absRoot, f);
    }

    // 4) 验证
    let shellOk = true;
    let lastError = "";
    for (const cmd of cmds) {
      const v = await runVerify(absRoot, cmd);
      attemptLog.push(`[${v.ok ? "PASS" : "FAIL"}] ${v.cmd}\n${digest(v.stdout + v.stderr, 2000)}`);
      if (!v.ok) { shellOk = false; lastError = `[${v.cmd}]\n${digest(v.stdout + v.stderr, ERROR_DIGEST)}`; break; }
    }
    if (!shellOk) {
      currentTask = `上一轮修改未通过验证，请根据以下错误原文重新修复：\n${lastError}`;
      continue;
    }

    // 5) critic
    const diff = await gitDiff(absRoot);
    if (!shouldSkipCritic(diff)) {
      const c = await runCritic({ task: currentTask, rubric: manifest.rubric ?? "", diff, lastShellOutput: "" });
      attemptLog.push(`[critic] ${c.pass ? "PASS" : "FAIL"} score=${c.score} fatal=${c.fatal}\n${c.detail.slice(0, 600)}`);
      if (!c.pass && c.fatal) {
        currentTask = `评审发现严重问题，必须修复：${c.detail}`;
        await gitRollback(absRoot, checkpoint);
        continue;
      }
    }

    console.error(attemptLog.join("\n"));
    return { status: "fixed", attempts: attempt, log: attemptLog.join("\n") };
  }

  await gitRollback(absRoot, checkpoint);
  return { status: "failed", attempts: maxRetries, log: attemptLog.join("\n") };
}

async function proposePlan(task: string, ctx: string, root: string, model:string): Promise<Proposal> {
  const prompt =
    `任务：${task}\n上下文：${ctx}\n\n` +
    `输出严格 JSON：{"summary":"一句话","files":[{"path":"相对路径","action":"edit|create|delete","reason":"为什么必须改它","newContent":"完整新内容"}]}\n` +
    `约束：只列真实存在的文件（新建除外）；path 相对于工作目录；不要列 .git/node_modules；edit 必须提供 newContent（完整文件内容）。`;
  const resp = await client.chat.completions.create({
    model: model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    response_format: { type: "json_object" },
  });
  const obj = JSON.parse(resp.choices[0].message.content ?? "{}");
  const files = (Array.isArray(obj.files) ? obj.files : []).map((f: any) => {
    const r = resolvePath(root, f.path);
    const before = r.abs ? safeRead(r.abs) : "";
    return {
      path: String(f.path),
      action: (["edit", "create", "delete"].includes(f.action) ? f.action : "edit") as FileOp["action"],
      before,
      after: f.action === "delete" ? "" : (String(f.newContent ?? before)),
      reason: String(f.reason ?? ""),
    };
  });
  return { id: proposalId(), files, summary: String(obj.summary ?? "") };
}

async function applyOp(root: string, op: FileOp): Promise<void> {
  const r = resolvePath(root, op.path);
  if (op.action === "delete" && r.abs) {
    await fs.unlink(r.abs);
    console.error(`[audit] DELETE ${r.abs}`);
    return;
  }
  if (op.action === "create" || op.action === "edit") {
    await fs.mkdir(path.dirname(r.abs), { recursive: true });
    await fs.writeFile(r.abs, op.after, "utf-8");
    console.error(`[audit] WRITE ${r.abs}`);
    return;
  }
}

function safeRead(abs: string): Promise<string> {
  return fs.readFile(abs, "utf-8").catch(() => "");
}

export { setAllowed, clearAllowed };