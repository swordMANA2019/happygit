import OpenAI from "openai";
import path from "node:path";
import { runAgent } from "./agent.js";
import { buildContext } from "./context.js";
import crypto from "node:crypto";
import { MODEL, MAX_RETRIES, ERROR_DIGEST, VERIFY_TIMEOUT_MS } from "./config.js";
import type { ApproveFn } from "./tools/ctx.js";
import { ensureManifest, type Manifest } from "./probe.js";
import { runCritic, shouldSkipCritic } from "./critic.js";
import { execCommand } from "./tools/shell.js";
import { Workspace, gitInfo, untrackedSideEffects } from "./workspace.js";
import { stripAnsi, truncateMiddle } from "./util.js";
import type { FailureKind } from "./errors.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/* =========================================================================
 * 验证
 * ========================================================================= */

export type VerifyResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  cmd: string;
  /** ok=false 时：code=代码有问题；env/timeout=验证器本身没跑起来（结论不可信） */
  kind: "ok" | FailureKind;
  reason: string;
  code: number | null;
};

export async function runVerify(root: string, cmd: string, signal?: AbortSignal): Promise<VerifyResult> {
  const r = await execCommand(cmd, { cwd: root, timeoutMs: VERIFY_TIMEOUT_MS, signal });
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, cmd, kind: r.kind, reason: r.reason, code: r.code };
}

function digest(text: string, max = ERROR_DIGEST): string {
  return truncateMiddle(stripAnsi(text), max);
}

const outputOf = (v: VerifyResult) => digest(`${v.stderr}\n${v.stdout}`.trim(), ERROR_DIGEST);

/* =========================================================================
 * 主流程
 * ========================================================================= */

export type FixOpts = {
  autoRetry?: boolean;
  requireConfirm?: boolean;
  signal?: AbortSignal;
  /** 失败时也保留 Agent 的改动（默认回滚）。也可用环境变量 AGENT_KEEP_ON_FAIL=1 */
  keepOnFail?: boolean;
  sessionId?: string;
  model?: string;
  /** 高风险写操作的交互确认；缺省 = 非交互（这类操作会被拒绝并告知模型） */
  approve?: ApproveFn;
  /** 本会话已授权的文件集合（跨多次任务共享） */
  approved?: Set<string>;
  /**
   * 会话历史（由 Session 持有，会被原地追加）。传入后本次任务就是这段连续对话的一个回合：
   * 模型能看到之前所有回合的提问、工具调用与回答。不传则只在本次任务内保持上下文。
   */
  messages?: Msg[];
  /**
   * 延后基线验证：不在开始前跑测试，而是等模型第一次真正要写文件时才跑（此时文件仍是原样）。
   * 用于"统一入口"：用户的话可能只是提问/分析，此时不应白跑一遍测试；一旦要改代码，基线证据照样拿到。
   * 不开启则和以前一样：先跑基线、证据放进第一轮 prompt（/fix 用）。
   */
  deferBaseline?: boolean;
};

/**
 * fixed       验证器全部通过（且评审没有否决）
 * unverified  改动已完成，但没有可用验证器（环境问题）——如实标注，不假装通过
 * no_change   模型没有做任何文件改动（无需修改 / 无法修改）
 * failed      多轮后仍未通过；已回滚（除非 keepOnFail）
 * aborted     用户中断；改动保留，可用 /undo 撤销
 */
export type FixStatus = "fixed" | "unverified" | "no_change" | "failed" | "aborted";

export type FixResult = {
  status: FixStatus;
  attempts: number;
  log: string;
  changedFiles: string[];
  rolledBack: boolean;
  warnings: string[];
  /** Agent 最后一次的文字回答（问答类回合里，这就是给用户的答案） */
  answer: string;
  /** 保留着的检查点；上层可调用 workspace.rollback() 实现 /undo */
  workspace: Workspace;
};

export async function runFixTask(task: string, rootDir: string, opts: FixOpts = {}): Promise<FixResult> {
  const root = path.resolve(rootDir);
  const { autoRetry = true, signal } = opts;
  const model = opts.model ?? MODEL;
  const sessionId = opts.sessionId ?? crypto.randomBytes(8).toString("hex");
  const approved = opts.approved ?? new Set<string>();
  const keepOnFail = opts.keepOnFail ?? process.env.AGENT_KEEP_ON_FAIL === "1";
  const maxRetriesCfg = autoRetry ? MAX_RETRIES : 1;

  const ws = new Workspace(root);
  const warnings: string[] = [];
  const roundLogs: string[] = [];
  let attempts = 0;
  let lastAnswer = "";
  let gitBefore: Awaited<ReturnType<typeof gitInfo>> = { state: "not_repo" };

  const finish = async (status: FixStatus, extra?: string): Promise<FixResult> => {
    const touched = await ws.changedFiles().catch(() => [] as string[]);
    let rolledBack = false;
    if (status === "failed" && !keepOnFail) {
      await ws.rollback();
      rolledBack = true;
    }
    // run_command 的副作用无法进 journal（也就无法回滚）——有 git 就尽力提醒，没有就算了
    try {
      const after = await gitInfo(root);
      const side = await untrackedSideEffects(gitBefore, after, touched);
      if (side.length) warnings.push(`run_command 可能产生了未纳入检查点、无法自动回滚的改动：${side.slice(0, 8).join(", ")}`);
    } catch { /* 附加提示，失败就不提示 */ }

    const log = [...roundLogs, extra, warnings.length ? `[warnings]\n- ${warnings.join("\n- ")}` : ""].filter(Boolean).join("\n");
    return { status, attempts, log, changedFiles: rolledBack ? [] : touched, rolledBack, warnings, answer: lastAnswer || extra || "", workspace: ws };
  };

  try {
    /* ---- 1. 环境探测：任何一步失败都降级，而不是崩溃 ---- */
    let manifest: Manifest;
    try {
      manifest = await ensureManifest(root, model);
    } catch (e: any) {
      warnings.push(`项目探测失败（${e?.message ?? e}），将在没有预置验证器的情况下继续`);
      manifest = { lang: "unknown", verifyCommands: [], probedAt: Date.now(), mtimes: {} };
    }

    gitBefore = await gitInfo(root);
    if (gitBefore.state === "unavailable") {
      warnings.push(`git 不可用（${gitBefore.detail}）：不影响修复与回滚——检查点由内置的文件日志负责，仅缺少 git 辅助信息`);
    }

    const override = process.env.AGENT_VERIFY_CMD;
    let cmds = override ? [override] : [...manifest.verifyCommands];
    for (const r of manifest.rejected ?? []) warnings.push(`验证命令已排除：${r.cmd}（${r.reason}）`);

    /* ---- 2. 基线验证：在模型动手前拿到客观事实 ----
     *   - 验证器本身跑不起来（env/timeout）→ 现在就剔除，别等到烧完重试次数才发现
     *   - 验证器报代码错误 → 原文作为第一轮的证据直接喂给模型
     */
    let baselineDone = false;
    const runBaseline = async (): Promise<string> => {
      if (baselineDone) return "";
      baselineDone = true;
      let evidence = "";
      const usable: string[] = [];
      for (const cmd of cmds) {
        if (signal?.aborted) break;
        const v = await runVerify(root, cmd, signal);
        if (!v.ok && v.kind !== "code") {
          warnings.push(`验证器不可用：${cmd}（${v.reason}）`);
          continue;
        }
        usable.push(cmd);
        if (!v.ok) evidence += `\n[${cmd}]（退出码 ${v.code}）\n${outputOf(v)}\n`;
      }
      cmds = usable;
      if (cmds.length === 0) {
        warnings.push("没有任何可用的验证器：本次修改只能由模型自检 + 评审把关，结果将标记为“未验证”");
      }
      console.error(`[fix] lang=${manifest.lang} verifiers=[${cmds.join(", ") || "无"}]`);
      return evidence;
    };
    // 无法验证时重试没有意义（没有新证据可喂）；延后基线时，这个值要等基线跑完才准确，所以每轮重算
    const maxRetries = () => (cmds.length > 0 ? maxRetriesCfg : 1);

    /* ---- 3. 主循环（同一会话持续，而不是每轮重建上下文） ---- */
    let ctx = "";
    try { ctx = await buildContext(root, model); } catch (e: any) { warnings.push(`构建上下文失败：${e?.message ?? e}`); }

    // 历史由 Session 传入并原地追加；单独调用时用一个本地数组，同样能跨重试保持上下文
    const convo: Msg[] = opts.messages ?? [];

    let prompt = task;
    if (!opts.deferBaseline) {
      const evidence = await runBaseline();
      if (signal?.aborted) return finish("aborted");
      prompt += evidence
        ? `\n\n【修改前的真实验证输出（客观证据，请据此定位）】${evidence}`
        : cmds.length > 0 ? "\n\n（修改前验证命令全部通过。）" : "";
    }

    const beforeWrite = opts.deferBaseline
      ? async () => {
          if (baselineDone) return;
          const evidence = await runBaseline();
          if (evidence) return `[修改前基线验证——以下失败在你动手之前就存在，请据此判断是否与本任务有关]${evidence}`;
          if (cmds.length > 0) return "[修改前基线验证：全部通过]";
        }
      : undefined;

    let lastFp = "";
    let lastSig = "";
    let lastFailure = "";

    for (let attempt = 1; attempt <= maxRetries(); attempt++) {
      attempts = attempt;
      if (signal?.aborted) return finish("aborted");

      const r = await runAgent(prompt, ctx, {
        root, sessionId, model, mode: "agent", workspace: ws, signal, messages: convo,
        task, approve: opts.approve, approved, beforeWrite,
      });
      if (r.text) lastAnswer = r.text;
      const roundLog: string[] = [`--- attempt ${attempt} ---`, `agent: [${r.status}] steps=${r.steps} tools=${r.toolCalls} | ${r.text.slice(0, 200).replace(/\s+/g, " ")}`];
      roundLogs.push(roundLog.join("\n"));

      if (r.status === "aborted") return finish("aborted", "用户中断，已保留当前改动（可 /undo 撤销）");
      if (r.status === "llm_error") {
        // 模型都不可用了，不要在半成品上继续验证；让 finish 回滚
        return finish("failed", `LLM 不可用，已停止：${r.text}`);
      }

      /* -- 统一入口下的纯问答/分析回合：没改任何文件就不需要验证，答案本身就是结果 -- */
      if (opts.deferBaseline && (await ws.changedFiles()).length === 0) {
        return finish("no_change");
      }

      /* -- 验证：只有 kind=code 的失败才算"代码没改对" -- */
      let failed: VerifyResult | null = null;
      let passedCount = 0;
      let lastOutput = "";
      for (const cmd of [...cmds]) {
        const v = await runVerify(root, cmd, signal);
        const line = `[${v.ok ? "PASS" : v.kind === "code" ? "FAIL" : "INCONCLUSIVE"}] ${v.cmd}${v.ok ? "" : `（${v.reason}）`}`;
        roundLogs.push(`${line}\n${v.ok ? "" : digest(`${v.stderr}\n${v.stdout}`.trim(), 2000)}`.trimEnd());
        lastOutput = `${v.stderr}\n${v.stdout}`;
        if (v.ok) { passedCount++; continue; }
        if (v.kind === "code") { failed = v; break; }
        // 验证器在本轮突然跑不起来了（超时 / 被删 / 环境变化）：既不能算过也不能算错
        warnings.push(`验证器本轮不可用：${v.cmd}（${v.reason}）`);
        cmds = cmds.filter((c) => c !== cmd);
      }

      if (failed) {
        lastFailure = `[${failed.cmd}]\n${outputOf(failed)}`;
        // 进展检测：改动指纹和报错都和上一轮一样 = 模型在原地打转，继续烧钱没有意义
        const fp = await ws.fingerprint();
        const sig = digest(`${failed.stderr}${failed.stdout}`, 400);
        if (attempt > 1 && fp === lastFp && sig === lastSig) {
          roundLogs.push("连续两轮改动与报错完全相同，判定无进展，提前终止");
          break;
        }
        lastFp = fp; lastSig = sig;
        prompt =
          `上一轮修改未通过验证，请根据以下错误原文重新修复（只改相关行，不要注释或删除测试、不要吞错误）：\n${lastFailure}\n\n` +
          `如果你判断这是环境问题而不是代码问题，请直接说明原因并停止修改。`;
        continue;
      }

      /* -- 到这里：没有"代码层失败" -- */
      const changed = await ws.changedFiles();
      if (changed.length === 0) {
        return finish("no_change", `模型未修改任何文件：${r.text.slice(0, 300)}`);
      }

      /* -- LLM 评审：只有否决权，不能单方面放行 -- */
      const diff = await ws.diff();
      if (!shouldSkipCritic(diff)) {
        const c = await runCritic({ task, rubric: manifest.rubric ?? "", diff, lastShellOutput: lastOutput }, model);
        roundLogs.push(`[critic] ${c.pass ? "PASS" : "FAIL"} score=${c.score} fatal=${c.fatal}\n${c.detail.slice(0, 600)}`);
        if (!c.pass && c.fatal) {
          lastFailure = `评审否决：${c.detail}`;
          prompt = `评审发现严重问题，必须修复：${c.detail}\n请不要绕过检查，重新修改。`;
          continue;
        }
      }

      return finish(passedCount > 0 ? "fixed" : "unverified");
    }

    return finish("failed", lastFailure ? `最后一次失败：\n${lastFailure}` : undefined);
  } catch (e: any) {
    // 兜底：未预料的异常也要回滚，并且作为结果返回而不是抛给 REPL
    roundLogs.push(`[内部错误] ${e?.stack ?? e}`);
    return finish("failed", `内部错误：${e?.message ?? e}`);
  }
}
