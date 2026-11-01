import { exec } from "node:child_process";
import { promisify } from "node:util";
import { runTask } from "./agent.js";
import { buildContext } from "./context.js";
import { ROOT, MAX_RETRIES, ERROR_DIGEST } from "./config.js";
import { ensureManifest, invalidateManifest } from "./probe.js";
import { runCritic, shouldSkipCritic } from "./critic.js";

const execAsync = promisify(exec);

/* ---- git 沙盒 ---- */

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
      cwd: root, timeout: 90_000, maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return { ok: true, stdout, stderr, cmd };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e), cmd };
  }
}

function fallbackCmd(lang: string): string {
  return ({ python: "python -m compileall -q .", go: "go build ./...", rust: "cargo check", java: "mvn compile -q" })[lang] ?? "echo 'no verifier'";
}

function digest(text: string, max = ERROR_DIGEST): string {
  const t = text.replace(/\x1b  $ [0-9;]*m/g, "");
  return t.length <= max ? t : t.slice(0, max) + "\n...(truncated)";
}

/* ---- 主循环 ---- */

export type FixOpts = { autoRetry?: boolean; requireConfirm?: boolean };
export type FixResult = { status: "fixed" | "failed"; attempts: number; log: string };

export async function runFixTask(task: string, root = ROOT, opts: FixOpts = {}): Promise<FixResult> {
  const { autoRetry = true } = opts;
  const maxRetries = autoRetry ? MAX_RETRIES : 1;

  const manifest = await ensureManifest(root);
  const override = process.env.AGENT_VERIFY_CMD;
  const cmds = override ? [override] : manifest.verifyCommands.length ? manifest.verifyCommands : [fallbackCmd(manifest.lang)];

  console.error(`[fix] lang=${manifest.lang} cmds=[${cmds.join(", ")}] maxRetries=${maxRetries}`);

  const checkpoint = await gitCheckpoint(root, "before-fix");
  const attemptLog: string[] = [];
  let currentTask = task;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // runTask 是无状态的：必须把历史拼回 task，否则模型会重复同样的操作
    const ctx = await buildContext(root);
    const memo = attemptLog.length
      ? `\n\n【前几轮尝试·禁止重复】\n${attemptLog.join("\n")}\n请换一种思路修复，只改相关行，不要注释或删除测试、不要吞错误。`
      : "";

    const answer = await runTask(currentTask + memo, ctx);
    const roundLog: string[] = [`--- attempt ${attempt} ---`, `model: ${answer.slice(0, 200)}`];

    // shell 验证器串联：第一个失败的就把原文喂回去，短路进入下一轮
    let shellOk = true;
    let lastError = "";
    for (const cmd of cmds) {
      const v = await runVerify(root, cmd);
      roundLog.push(`[${v.ok ? "PASS" : "FAIL"}] ${v.cmd}\n${digest(v.stderr + v.stdout, 2000)}`);
      if (!v.ok) {
        shellOk = false;
        lastError = `[${v.cmd}]\n${digest(v.stderr + v.stdout, ERROR_DIGEST)}`;
        break;
      }
    }

    if (!shellOk) {
      currentTask = `上一轮修改未通过验证，请根据以下错误原文重新修复：\n${lastError}`;
      attemptLog.push(roundLog.join("\n"));
      continue;
    }

    // shell 全过 → LLM critic 最后一道（只有否决权，不能单方面放行）
    const diff = await gitDiff(root);
    if (!shouldSkipCritic(diff)) {
      const c = await runCritic({ task: currentTask, rubric: manifest.rubric ?? "", diff, lastShellOutput: "" });
      roundLog.push(`[critic] ${c.pass ? "PASS" : "FAIL"} score=${c.score} fatal=${c.fatal}\n${c.detail.slice(0, 600)}`);
      if (!c.pass && c.fatal) {
        currentTask = `评审发现严重问题，必须修复：${c.detail}\n请不要绕过检查，重新修改。`;
        attemptLog.push(roundLog.join("\n"));
        continue;
      }
    }

    console.error(roundLog.join("\n"));
    return { status: "fixed", attempts: attempt, log: roundLog.join("\n") };
  }

  await gitRollback(root, checkpoint);
  return { status: "failed", attempts: maxRetries, log: attemptLog.join("\n") };
}