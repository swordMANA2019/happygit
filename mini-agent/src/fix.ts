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
import { stripAnsi, truncateMiddle, fmtSecs, withHeartbeat } from "./util.js";
import type { FailureKind } from "./errors.js";
import type { TaskState } from "./taskstate.js";
import type { JobManager } from "./tools/jobs.js";
import type { McpManager } from "./mcp.js";
import { snapshotTree, producedFiles } from "./snapshot.js";
import { resetStats, stats } from "./stats.js";
import { discoverSkills, skillVerifiers, type Skill } from "./skills.js";

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
  // 验证可能跑很久（pytest / 编译 / 导入 torch）：先说明在跑什么，期间周期性提示，结束后给出结论和用时
  // 多个验证器是并发跑的，所以每一行输出都带上命令，避免交错后分不清谁是谁
  const shown = cmd.length > 120 ? `${cmd.slice(0, 120)} …` : cmd;
  const short = cmd.length > 40 ? `${cmd.slice(0, 40)}…` : cmd;
  console.log(`\n🔍 验证：${shown}（超时 ${fmtSecs(VERIFY_TIMEOUT_MS)}）`);
  const t0 = Date.now();
  const r = await withHeartbeat(`验证运行中：${short}`, () => execCommand(cmd, { cwd: root, timeoutMs: VERIFY_TIMEOUT_MS, signal }));
  console.log(`${r.ok ? "✅ 验证通过" : r.kind === "code" ? "❌ 验证失败" : `⚠️  验证无法判定（${r.reason}）`}：${short}（用时 ${fmtSecs(Date.now() - t0)}）`);
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, cmd, kind: r.kind, reason: r.reason, code: r.code };
}

/** 只改了文档类文件：不需要自测 */
const DOCS_ONLY = /^(?:[^\n]*\.(?:md|txt|rst)\n?)+$/i;

/**
 * 黑盒自测的指令。关键约束：必须真正运行命令、必须有失败/边界场景、结论行格式固定（fix.ts 会解析并核对"是否真的跑过命令"）。
 * 方法细节在 blackbox-testing 技能里（含假 OpenAI 服务），这里只放"一定要做到"的部分。
 */
const SELFTEST_PROMPT = `【黑盒自测】这个项目没有可用的自动验证器，所以请你亲自验证刚才的改动——像测试工程师一样，把它当黑盒来测。

1. 先 use_skill("blackbox-testing") 阅读方法（已读过可跳过）。
2. 先想"怎样才能亲眼看到它出问题/不出问题"，再设计 2~4 个场景：至少 1 个正常路径 + 1 个失败/边界路径。缺什么条件就自己临时搭——涉及外部服务（HTTP / LLM 接口 / 数据库）就自己写个小桩服务按需要的方式表现；训练、长任务用最小数据 + 最少步数跑通一遍。每个场景先写下"期望看到什么"。
3. 测试脚本、假数据只放在 .agent/scratch/ 下；不要为了让测试通过而改项目代码里的判断/阈值/异常处理。
4. 用 run_command 真正运行（服务/长命令用 background=true，用完 stop_job）。把实际输出和期望对照。
5. 发现缺陷：修复项目代码并重跑同一场景。
6. 你的最后一条回复就是给用户的【最终报告】，按这个结构（每节简短，要点式）：
   ## 原因   —— 问题/需求的根因，一两句
   ## 改动   —— 改了哪些文件、各做了什么
   ## 验证   —— 每个场景一行：场景 → 命令 → 实际结果 → 结论；哪些没法测以及原因
   ## 注意事项 —— 局限、假设、需要用户决定或手动处理的事、后续建议
7. 报告的最后一行必须是下面三种之一（不要加别的字）：
   SELFTEST: PASS
   SELFTEST: FAIL（一句话原因）
   SELFTEST: SKIPPED（无法测试的原因）
没有真正运行过命令就不允许写 PASS——系统会核对你实际执行的命令数。`;

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
  /** 没有自动验证器时是否让模型做黑盒自测（默认开；也可用 AGENT_SELFTEST=0 关闭） */
  selfTest?: boolean;
  /** 项目外只读目录的授权（Session 持有） */
  extraRoots?: Set<string>;
  askExternal?: (dir: string) => Promise<boolean>;
  /**
   * 会话历史（由 Session 持有，会被原地追加）。传入后本次任务就是这段连续对话的一个回合：
   * 模型能看到之前所有回合的提问、工具调用与回答。不传则只在本次任务内保持上下文。
   */
  messages?: Msg[];
  /** 计划与笔记（由 Session 持有，跨回合保留） */
  state?: TaskState;
  /**
   * 延后基线验证：不在开始前跑测试，而是等模型第一次真正要写文件时才跑（此时文件仍是原样）。
   * 用于"统一入口"：用户的话可能只是提问/分析，此时不应白跑一遍测试；一旦要改代码，基线证据照样拿到。
   * 不开启则和以前一样：先跑基线、证据放进第一轮 prompt（/fix 用）。
   */
  deferBaseline?: boolean;
  /** 后台任务管理器 / 外部工具（MCP）/ 技能清单等：由 Session 持有并传入 */
  jobs?: JobManager;
  mcp?: McpManager;
  /** 拼进系统提示的额外段落（技能清单、MCP 说明） */
  extraContext?: string;
};

/**
 * fixed       验证器全部通过（且评审没有否决）
 * selftested  没有自动验证器，但模型做了黑盒自测（真正运行过命令）并通过——证据在回答里，强度低于 fixed
 * unverified  改动已完成，但没有可用验证器（环境问题），自测也没做成/没被采信——如实标注，不假装通过
 * no_change   模型没有做任何文件改动（无需修改 / 无法修改）
 * failed      多轮后仍未通过；已回滚（除非 keepOnFail）
 * aborted     用户中断；改动保留，可用 /undo 撤销
 */
export type FixStatus = "fixed" | "selftested" | "unverified" | "no_change" | "failed" | "aborted";

export type FixResult = {
  status: FixStatus;
  attempts: number;
  log: string;
  changedFiles: string[];
  /** 由 run_command（脚本）产出或修改的文件：不在检查点里，/undo 还原不了，但值得告诉用户（如生成的 .pptx） */
  produced: string[];
  rolledBack: boolean;
  warnings: string[];
  /** Agent 最后一次的文字回答（问答类回合里，这就是给用户的答案） */
  answer: string;
  /** 保留着的检查点；上层可调用 workspace.rollback() 实现 /undo */
  workspace: Workspace;
  /** 耗时统计（多行文本）：总用时、各阶段、模型调用次数/耗时、工具耗时 */
  timing: string;
  elapsedMs: number;
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
  let produced: string[] = [];
  let hasDynamicVerifier = false;
  const usedSkills = new Set<string>();
  let gitBefore: Awaited<ReturnType<typeof gitInfo>> = { state: "not_repo" };

  resetStats();

  const finish = async (status: FixStatus, extra?: string): Promise<FixResult> => {
    stats().enter("收尾");
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
    return { status, attempts, log, changedFiles: rolledBack ? [] : touched, produced, rolledBack, warnings, answer: lastAnswer || extra || "", workspace: ws, timing: stats().render(), elapsedMs: stats().total() };
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
      // 验证器彼此独立（lint / 类型检查 / 测试），并发跑：总用时 = 最慢的那个，而不是全部相加
      const prevPhase = stats().enter("验证");
      const results = signal?.aborted ? [] : await Promise.all(cmds.map((cmd) => runVerify(root, cmd, signal)));
      stats().enter(prevPhase);
      for (const v of results) {
        const cmd = v.cmd;
        if (!v.ok && v.kind !== "code") {
          warnings.push(`验证器不可用：${cmd}（${v.reason}）`);
          continue;
        }
        usable.push(cmd);
        if (!v.ok) evidence += `\n[${cmd}]（退出码 ${v.code}）\n${outputOf(v)}\n`;
      }
      cmds = usable;
      if (cmds.length === 0) {
        warnings.push("没有任何可用的验证器：本次修改将由模型黑盒自测 + 评审把关（自测没做成则标记为“未验证”）");
      }
      console.error(`[fix] lang=${manifest.lang} verifiers=[${cmds.join(", ") || "无"}]`);
      return evidence;
    };
    // 无法验证时重试没有意义（没有新证据可喂）；延后基线时，这个值要等基线跑完才准确，所以每轮重算
    const selfTestEnabled = opts.selfTest !== false && process.env.AGENT_SELFTEST !== "0";
    // 自测发现问题时也要能回头修，所以开启自测时同样给足轮数
    const maxRetries = () => (cmds.length > 0 || hasDynamicVerifier || selfTestEnabled ? maxRetriesCfg : 1);

    /* ---- 3. 主循环（同一会话持续，而不是每轮重建上下文） ---- */
    // 构建上下文 / 目录快照 / 技能清单互不依赖，并发做
    // （快照：任务后对比，找出脚本（run_command）产出的文件；技能清单用于查找技能声明的验证器）
    let ctx = "";
    const [ctxRes, snapBefore, skills] = await Promise.all([
      buildContext(root, model, opts.extraContext).then((c) => ({ ok: true as const, c }), (e: any) => ({ ok: false as const, e })),
      snapshotTree(root),
      discoverSkills(root).catch(() => [] as Skill[]),
    ]);
    if (ctxRes.ok) ctx = ctxRes.c; else warnings.push(`构建上下文失败：${ctxRes.e?.message ?? ctxRes.e}`);

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

      stats().enter("主循环");
      const r = await runAgent(prompt, ctx, {
        root, sessionId, model, mode: "agent", workspace: ws, signal, messages: convo,
        task, approve: opts.approve, approved, beforeWrite, state: opts.state,
        jobs: opts.jobs, mcp: opts.mcp, usedSkills,
        extraRoots: opts.extraRoots, askExternal: opts.askExternal,
      });
      if (r.text) lastAnswer = r.text;
      const roundLog: string[] = [`--- attempt ${attempt} ---`, `agent: [${r.status}] steps=${r.steps} tools=${r.toolCalls} | ${r.text.slice(0, 200).replace(/\s+/g, " ")}`];
      roundLogs.push(roundLog.join("\n"));

      if (r.status === "aborted") return finish("aborted", "用户中断，已保留当前改动（可 /undo 撤销）");
      if (r.status === "llm_error") {
        // 模型都不可用了，不要在半成品上继续验证；让 finish 回滚
        return finish("failed", `LLM 不可用，已停止：${r.text}`);
      }

      /* -- 本回合到底产出了什么：检查点里的改动 + 脚本生成的文件 -- */
      const changedNow = await ws.changedFiles();
      produced = producedFiles(snapBefore, await snapshotTree(root), changedNow);

      /* -- 统一入口下的纯问答/分析回合：没改/没产出任何文件就不需要验证，答案本身就是结果 -- */
      if (opts.deferBaseline && changedNow.length === 0 && produced.length === 0) {
        return finish("no_change");
      }

      /* -- 验证：项目自带的验证器 + 本任务用过的技能声明的验证器（针对产出的文件）。
       *    只产出了文件（如脚本生成的 pptx）而没改代码时，跑项目测试没有意义，只跑技能验证器。 -- */
      const dyn = await skillVerifiers(skills, usedSkills, [...changedNow, ...produced]);
      if (dyn.length) hasDynamicVerifier = true;

      /* -- 统一入口下没改任何文件、也没有技能验证器要跑：这是一次问答/查看回合，不进验证/评审/"未验证"流程。
       *    （snapshot 里的"产出文件"可能只是上一回合起的后台训练还在写日志/checkpoint、或 __pycache__，
       *      不能因此把一句提问当成"已完成修改但未能验证"）。产出文件仍会随结果展示。 -- */
      if (opts.deferBaseline && changedNow.length === 0 && dyn.length === 0) {
        return finish("no_change");
      }
      const toRun = changedNow.length > 0 || !opts.deferBaseline ? [...cmds, ...dyn] : dyn;

      /* -- 验证：只有 kind=code 的失败才算"代码没改对" -- */
      let failed: VerifyResult | null = null;
      let passedCount = 0;
      let lastOutput = "";
      stats().enter("验证");
      const vResults = await Promise.all(toRun.map((cmd) => runVerify(root, cmd, signal)));   // 并发：总用时 = 最慢的一个
      for (const v of vResults) {
        const cmd = v.cmd;
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
      const changed = changedNow;
      if (changed.length === 0 && produced.length === 0) {
        return finish("no_change", `模型未修改任何文件：${r.text.slice(0, 300)}`);
      }

      /* -- LLM 评审：只有否决权，不能单方面放行 -- */
      // 没有任何验证器通过、且会进入黑盒自测时，评审先不做：自测有真实运行的证据，评审只是再多等一次模型调用
      const diff = await ws.diff();
      const selfTestWillRun = passedCount === 0 && selfTestEnabled && changedNow.length > 0 && !DOCS_ONLY.test(changedNow.join("\n"));
      if (!selfTestWillRun && !shouldSkipCritic(diff)) {
        stats().enter("评审");
        console.log(`\n🧐 评审改动中…`);
        const tc = Date.now();
        const c = await withHeartbeat("评审改动", () => runCritic({ task, rubric: manifest.rubric ?? "", diff, lastShellOutput: lastOutput }, model));
        console.log(`${c.pass ? "✅ 评审通过" : c.fatal ? "❌ 评审否决" : "⚠️  评审有保留意见"}（用时 ${fmtSecs(Date.now() - tc)}）`);
        roundLogs.push(`[critic] ${c.pass ? "PASS" : "FAIL"} score=${c.score} fatal=${c.fatal}\n${c.detail.slice(0, 600)}`);
        if (!c.pass && c.fatal) {
          lastFailure = `评审否决：${c.detail}`;
          prompt = `评审发现严重问题，必须修复：${c.detail}\n请不要绕过检查，重新修改。`;
          continue;
        }
      }

      /* -- 没有任何自动验证器通过：不能就此宣布"完成"。让模型亲自黑盒自测（真的跑起来看），并用硬证据约束它 -- */
      if (selfTestWillRun) {
        // 快速通道：模型在最后一次改动【之后】自己已经真正运行过有意义的命令（不是 cat/ls），且最后一条成功——
        // 并且它的最终回复里已有"验证"一节（规则 17）。再开一整轮自测只是把同样的事重做一遍。
        if (r.status === "done" && r.evidence.runs > 0 && r.evidence.lastOk === true && /验证/.test(r.text)) {
          const cmdShown = r.evidence.lastCmd.length > 100 ? `${r.evidence.lastCmd.slice(0, 100)} …` : r.evidence.lastCmd;
          console.log(`\n✅ 模型在改完之后已自行运行验证（${r.evidence.runs} 条命令，最后一条成功），跳过单独的自测轮`);
          roundLogs.push(`[selftest] 快速通道：改动后模型自己运行了 ${r.evidence.runs} 条命令，最后一条成功：${r.evidence.lastCmd.slice(0, 200)}`);
          warnings.push(`验证依据：改完文件后模型自己运行了 \`${cmdShown}\` 并成功（没有单独的自测轮；证据强度取决于该命令是否真的覆盖了改动，请看回复里的“验证”一节）`);
          return finish("selftested");
        }
        stats().enter("自测");
        console.log(`\n🧪 没有可用的自动验证器，进入黑盒自测（模型自己设计场景并真正运行）…`);
        const st = await runAgent(SELFTEST_PROMPT, ctx, {
          root, sessionId, model, mode: "agent", workspace: ws, signal, messages: convo, maxSteps: 15,
          task, approve: opts.approve, approved, state: opts.state,
          jobs: opts.jobs, mcp: opts.mcp, usedSkills,
          extraRoots: opts.extraRoots, askExternal: opts.askExternal,
        });
        // 自测这一轮的最后回复就是最终报告（含"验证"一节）；结论行是给程序看的，展示时去掉
        if (st.text) lastAnswer = st.text.replace(/\n*SELFTEST:[^\n]*\s*$/i, "").trim();
        const verdictMatches = [...st.text.matchAll(/SELFTEST:\s*(PASS|FAIL|SKIPPED)\b([^\n]*)/gi)];
        const last = verdictMatches[verdictMatches.length - 1];
        const verdict = last?.[1].toUpperCase() ?? "NONE";
        const why = (last?.[2] ?? "").replace(/^[\s:：（(-]+|[)）\s]+$/g, "");
        roundLogs.push(`[selftest] ${verdict} commands=${st.commandRuns} status=${st.status}${why ? ` | ${why}` : ""}`);

        if (st.status === "aborted") return finish("aborted", "用户中断，已保留当前改动（可 /undo 撤销）");
        if (st.status === "llm_error") { warnings.push(`黑盒自测没有完成：${st.text}`); return finish("unverified"); }

        if (verdict === "PASS") {
          // 防止"没跑就说通过"：自测必须真的执行过命令
          if (st.commandRuns === 0) {
            warnings.push("模型声称黑盒自测通过，但本轮没有执行任何命令，不予采信（结果标记为未验证）");
            console.log("⚠️  自测结论不予采信：模型没有真正运行任何命令");
            return finish("unverified");
          }
          console.log(`✅ 黑盒自测通过（实际执行了 ${st.commandRuns} 条命令）`);
          return finish("selftested");
        }
        if (verdict === "FAIL") {
          console.log(`❌ 黑盒自测发现问题${why ? `：${why}` : ""}`);
          lastFailure = `黑盒自测发现问题：${why || st.text.slice(-600)}`;
          if (attempt < maxRetries()) {
            prompt = `黑盒自测发现了问题（见上文的测试输出）。请修复项目代码——不要改测试去迁就它——然后重新运行同样的场景确认，最后再按格式给出 SELFTEST 结论。`;
            continue;
          }
          break;
        }
        warnings.push(`黑盒自测没有得出结论（${verdict === "SKIPPED" ? "模型选择跳过" : "没有给出 SELFTEST 结论行"}）${why ? `：${why}` : ""}`);
        return finish("unverified");
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
