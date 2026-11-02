import readline from "node:readline/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { type Mode } from "./router.js";
import { MODEL } from "./config.js";
import { Session, type Prompter } from "./session.js";
import type { FixResult, FixOpts } from "./fix.js";

/** diag 是本地流程分支，不属于意图分类 */
type Branch = Mode | "diag";

/* ---- 展示 ---- */

function printBanner(ses: Session) {
  console.log(`Mini Agent | 模型：${ses.model} | 目录：${ses.cwd} | session：${ses.sessionId}`);
  console.log("命令：/fix <任务> | /edit <任务> | /ask <问题> | /diag <任务> | /undo | /probe | /context");
  console.log("      /cd <目录> | /pwd | /model <名> | /reset | /exit      （任务运行中 Ctrl+C 可中断）");
}

function describe(res: FixResult): string {
  const files = res.changedFiles.length ? `\n改动文件：\n  ${res.changedFiles.join("\n  ")}` : "";
  switch (res.status) {
    case "fixed":
      return `\n✅ 修复成功（${res.attempts} 轮，验证通过）${files}\n（不满意可输入 /undo 撤销）\n${res.log}`;
    case "unverified":
      return `\n⚠️  已完成修改，但【未能自动验证】（详见 warnings）${files}\n（可输入 /undo 撤销）\n${res.log}`;
    case "no_change":
      return `\nℹ️  模型没有修改任何文件\n${res.log}`;
    case "aborted":
      return `\n⏹  已中断，当前改动已保留${files}\n（输入 /undo 可撤销）\n${res.log}`;
    case "failed":
      return res.rolledBack
        ? `\n❌ 修复失败，所有改动已回滚到修复前状态\n${res.log}`
        : `\n❌ 修复失败，改动已按配置保留${files}\n${res.log}`;
  }
}

/** 打印诊断报告，并让用户选择要修哪几条 */
async function askWhichToFix(ses: Session, report: string): Promise<string | null> {
  console.log(`\n${report}`);
  while (true) {
    const ans = ((await ses.prompter?.ask("\n要修复哪些？编号(如 1,3) / y 全部 / n 放弃：")) ?? "n").trim().toLowerCase();
    if (ans === "n" || ans === "no" || ans === "") return null;
    if (ans === "y" || ans === "yes") return "__all__";
    if (/^\d[\d,\s]*$/.test(ans)) return ans;
    console.log("无法识别，请输入编号、y 或 n。");
  }
}

function pickIssues(report: string, spec: string): string {
  const blocks = report.split(/^##\s+/m).filter((b) => b.trim());
  if (blocks.length === 0) return report;
  const nums = spec.split(/[,，\s]+/).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
  return nums.map((n) => blocks[n - 1]).filter(Boolean).join("\n## ") || report;
}

async function appendAudit(ses: Session, record: Record<string, unknown>) {
  try {
    const dir = path.join(ses.cwd, ".agent");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "fix-log.jsonl"), JSON.stringify({ ts: Date.now(), session: ses.sessionId, ...record }) + "\n");
  } catch { /* 审计失败不应影响主流程 */ }
}

/* ---- 单条输入的处理（REPL 与单次调用共用） ---- */

async function handle(ses: Session, input: string): Promise<void> {
  let forced: Branch | null = null;
  let body = input;
  if (input.startsWith("/fix ")) { forced = "fix"; body = input.slice(5).trim(); }
  else if (input.startsWith("/edit ")) { forced = "edit"; body = input.slice(6).trim(); }
  else if (input.startsWith("/ask ")) { forced = "ask"; body = input.slice(5).trim(); }
  else if (input.startsWith("/diag ")) { forced = "diag"; body = input.slice(6).trim(); }

  // 显式命令跳过 LLM 路由；路由本身失败会在 router 内降级，不会抛
  const r = forced
    ? { mode: forced as Mode, reason: "(forced)", missing: [] as string[] }
    : await ses.route(input);
  const branch: Branch = forced ?? r.mode;
  console.error(`[router] ${branch} | ${r.reason}`);

  if (r.mode === "clarify" && !forced) {
    console.log(`\n我需要先确认几点：\n${r.missing.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n补充后重发，或 /fix 强制进入修复模式。`);
    return;
  }

  /* ---- ask：只读工具集，写工具根本不可见 ---- */
  if (branch === "ask") {
    const out = await ses.ask(input);
    console.log(`\n助手> ${out.status === "done" ? "" : `[${out.status}] `}${out.text}`);
    return;
  }

  /* ---- diag：只读诊断 → 出报告 → 等人选 ---- */
  if (branch === "diag" || (branch === "fix" && forced === null && /(找出|缺陷|问题|哪里不对|有什么毛病)/.test(input))) {
    if (!ses.prompter) { console.log("诊断模式需要交互确认，请在交互终端中使用。"); return; }
    console.error("[diag] 只读诊断中…");
    const { report } = await ses.diagnose(body);
    const which = await askWhichToFix(ses, report);
    if (!which) { console.log("已取消，未做任何修改。"); return; }
    body = which === "__all__" ? report : pickIssues(report, which);
  }

  /* ---- edit / fix：统一进验证闭环 ---- */
  const opts: FixOpts = { autoRetry: branch !== "edit", requireConfirm: branch === "edit" };
  const res = await ses.fix(body, opts);
  console.log(describe(res));
  await appendAudit(ses, {
    cwd: ses.cwd, branch, task: body.slice(0, 200),
    status: res.status, attempts: res.attempts, files: res.changedFiles, warnings: res.warnings.length,
  });
}

/* ---- 主入口 ---- */

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--yes");   // --yes 由 autoAllowed() 单独读取
  const argTask = argv.join(" ").trim();

  const interactive = Boolean(stdin.isTTY);
  const rl = interactive || !argTask ? readline.createInterface({ input: stdin, output: stdout }) : null;

  // 全程只有这一个 readline：REPL 输入与"是否应用变更？"确认都走它
  const prompter: Prompter | null = rl
    ? { ask: async (q, signal) => { try { return await rl.question(q, { signal }); } catch { return ""; } } }
    : null;
  const ses = new Session(process.cwd(), MODEL, prompter);

  // CLI 单次调用：走和 REPL 同一条路径，保证有检查点/验证/回滚
  if (argTask) {
    try { await handle(ses, argTask); } finally { rl?.close(); }
    return;
  }

  printBanner(ses);

  // Ctrl+C：任务运行中 → 只中断任务；空闲时 → 退出
  rl!.on("SIGINT", () => {
    if (ses.interrupt()) {
      console.log("\n[中断] 正在停止当前任务…");
    } else {
      rl!.close();
      process.exit(0);
    }
  });

  try {
    while (true) {
      let input: string;
      try {
        input = (await rl!.question("\n你> ")).trim();
      } catch {
        break; // 输入流关闭（Ctrl+D / 管道结束）
      }
      if (!input) continue;

      // —— 内置命令 ——
      if (input === "/exit" || input === "/quit") break;
      if (input === "/context") { console.log(await ses.context()); continue; }
      if (input === "/pwd") { console.log(ses.cwd); continue; }
      if (input === "/probe") { await ses.probe(); console.log(`已重新探测了 ${ses.cwd}`); continue; }
      if (input === "/reset") { ses.resetHistory(); console.log("上下文已清空"); continue; }
      if (input.startsWith("/model ")) {
        ses.model = input.slice(7).trim();     // 只改本会话；所有 LLM 调用都读 ses.model
        console.log(`已切换模型：${ses.model}`);
        continue;
      }
      if (input.startsWith("/cd ")) {
        try { console.log(`已切换目录：${ses.chdir(input.slice(4).trim())}（历史/撤销点/授权已重置）`); }
        catch (e: any) { console.log(e.message); }
        continue;
      }
      if (input === "/undo") {
        const files = await ses.undo();
        console.log(files === null ? "没有可撤销的改动。" :
          files.length ? `已撤销，还原了 ${files.length} 个文件：\n  ${files.join("\n  ")}` : "没有需要还原的文件。");
        continue;
      }

      try {
        await handle(ses, input);
      } catch (e: any) {
        // 单条任务的异常不应让整个会话退出
        console.error(`\n[错误] ${e?.message ?? e}`);
      }
    }
  } finally {
    rl!.close();
  }
}

process.on("unhandledRejection", (e) => { console.error("[unhandledRejection]", e); });
main().catch((e) => { console.error(e); process.exit(1); });
