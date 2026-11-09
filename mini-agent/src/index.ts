import readline from "node:readline/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { MODEL, ALWAYS_STATS } from "./config.js";
import { Session, type Prompter } from "./session.js";
import type { FixResult, FixOpts } from "./fix.js";
import {
  buildDiffs, renderSummary, renderFileDiff, pickDiffs, writeHtml, openExternal, openInIde,
} from "./ui/diffview.js";
import { runDiffViewer, openInVim } from "./ui/diffviewer.js";

/**
 * 没有"意图路由器"：不再由一个分类器（LLM 或关键字）先替用户决定这句话是问答还是修改。
 * 和 Cursor 一样，由用户选模式、由模型自己理解请求：
 *   默认（Agent） —— 完整工具集，模型自己判断是回答、分析还是改代码；改了文件才进验证闭环
 *   /ask         —— 只读工具集，写工具根本不可见
 *   /fix /edit /diag —— 用户显式指定的流程
 */
type Branch = "agent" | "ask" | "fix" | "edit" | "diag";

/* ---- 展示 ---- */

function printBanner(ses: Session) {
  console.log(`Mini Agent | 模型：${ses.model} | 目录：${ses.cwd} | session：${ses.sessionId}`);
  console.log("直接输入即可（Agent 模式：自行判断回答或修改）。命令：/ask <问题> 只读问答 | /fix <任务> | /edit <任务> | /diag <任务> | /undo | /diff [编号|html|ide] 高亮查看改动");
  console.log("      /plan 计划与笔记 | /jobs 后台任务 | /skills 技能 | /mcp [reload] 外部工具 | /resume 恢复上次对话 | /reset 清空对话 | /probe | /context | /cd <目录> | /pwd | /model <名> | /exit   （任务运行中 Ctrl+C 可中断）");
}

function describe(res: FixResult): string {
  const files =
    (res.changedFiles.length ? `\n改动文件：\n  ${res.changedFiles.join("\n  ")}` : "") +
    (res.produced.length ? `\n脚本产出/修改的文件（不在检查点里，/undo 无法还原）：\n  ${res.produced.slice(0, 20).join("\n  ")}` : "");
  const answer = res.answer ? `\n助手> ${res.answer}\n` : "";
  switch (res.status) {
    case "fixed":
      return `${answer}\n✅ 修改完成（${res.attempts} 轮，验证通过）${files}\n（不满意可输入 /undo 撤销）\n${res.log}`;
    case "selftested":
      return `${answer}\n✅ 修改完成，并通过【模型黑盒自测】（项目没有自带验证器；结论取决于上面“验证”一节里的实际运行证据）${files}\n（不满意可输入 /undo 撤销）\n${res.log}`;
    case "unverified":
      return `${answer}\n⚠️  已完成修改，但【未能自动验证】（详见 warnings）${files}\n（可输入 /undo 撤销）\n${res.log}`;
    case "no_change":
      // 最常见的是纯问答/分析回合：答案就是结果，不需要任何"没有修改"的噪音
      return `${answer}${res.warnings.length ? `\n[warnings]\n- ${res.warnings.join("\n- ")}` : ""}`;
    case "aborted":
      return `${answer}\n⏹  已中断，当前改动已保留${files}\n（输入 /undo 可撤销）\n${res.log}`;
    case "failed":
      return res.rolledBack
        ? `${answer}\n❌ 任务失败，所有改动已回滚到修改前状态\n${res.log}`
        : `${answer}\n❌ 任务失败，改动已按配置保留${files}\n${res.log}`;
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

/**
 * /diff [编号|路径]        内置交互式查看器（默认；任何终端都能用，不需要 vim / 浏览器）
 * /diff print [编号|路径]  直接把高亮 diff 打印到终端（可复制、可重定向）
 * /diff vim [编号|路径]    用 vim -d 对比（没有 vim 时自动改用内置查看器）
 * /diff html [编号|路径]   生成 HTML（每个文件点击展开）并用浏览器打开
 * /diff ide [编号|路径]    用 Cursor / VS Code 的 diff 编辑器打开
 */
async function handleDiff(ses: Session, arg: string): Promise<void> {
  const diffs = await ses.lastDiffs();
  if (!diffs) { console.log("没有可查看的改动（最近一次任务没有修改文件，或已被 /undo 撤销）。"); return; }

  const m = /^(print|vim|html|ide)\b\s*(.*)$/i.exec(arg.trim());
  const mode = m ? m[1].toLowerCase() : "view";
  const sel = m ? m[2] : arg;

  const picked = pickDiffs(diffs, sel);
  if (typeof picked === "string") { console.log(picked); return; }

  if (mode === "view") {
    // 没指定文件 → 从文件列表开始；指定了 → 直接进入该文件
    await runDiffViewer(sel.trim() && sel.trim() !== "all" ? picked : diffs, sel.trim() && sel.trim() !== "all" && picked.length === 1 ? 0 : undefined);
    return;
  }
  if (mode === "vim") {
    if (!(await openInVim(ses.sessionId, picked))) {
      console.log("没有找到 vim（Windows 默认没有），改用内置查看器。");
      await runDiffViewer(picked);
    }
    return;
  }

  if (mode === "html") {
    const file = await writeHtml(ses.cwd, picked);
    const opened = await openExternal(file);
    console.log(opened ? `已在浏览器中打开：${file}` : `已生成：${file}\n（当前环境无法自动打开浏览器；用 Cursor/VS Code 或浏览器打开该文件即可，每个文件点击标题展开）`);
    return;
  }
  if (mode === "ide") {
    const r = await openInIde(ses.sessionId, picked);
    console.log(r.note);
    return;
  }
  for (const d of picked) console.log(`\n${renderFileDiff(d)}`);
}

/* ---- 单条输入的处理（REPL 与单次调用共用） ---- */

async function handle(ses: Session, input: string): Promise<void> {
  let forced: Branch | null = null;
  let body = input;
  if (input.startsWith("/fix ")) { forced = "fix"; body = input.slice(5).trim(); }
  else if (input.startsWith("/edit ")) { forced = "edit"; body = input.slice(6).trim(); }
  else if (input.startsWith("/ask ")) { forced = "ask"; body = input.slice(5).trim(); }
  else if (input.startsWith("/diag ")) { forced = "diag"; body = input.slice(6).trim(); }

  // 没有路由：显式命令走对应流程，其余一律交给 Agent 自己理解
  const branch: Branch = forced ?? "agent";
  console.error(`[mode] ${branch}`);

  /* ---- ask：只读工具集，写工具根本不可见 ---- */
  if (branch === "ask") {
    const out = await ses.ask(body);
    console.log(`\n助手> ${out.status === "done" ? "" : `[${out.status}] `}${out.text}`);
    return;
  }

  /* ---- diag：用户显式要求 → 只读诊断 → 出报告 → 等人选 ---- */
  if (branch === "diag") {
    if (!ses.prompter) { console.log("诊断模式需要交互确认，请在交互终端中使用。"); return; }
    console.error("[diag] 只读诊断中…");
    const { report } = await ses.diagnose(body);
    const which = await askWhichToFix(ses, report);
    if (!which) { console.log("已取消，未做任何修改。"); return; }
    // 报告已经在对话里了，这里只需说明用户的选择
    body = `请修复诊断报告中的这些问题：\n${which === "__all__" ? report : pickIssues(report, which)}`;
  }

  /* ---- agent / edit / fix：模型自己判断；改了文件才进验证闭环 ----
   *  /fix：用户声明有故障 → 先跑基线验证，把真实报错作为证据
   *  其余：基线延后到第一次写文件前，纯问答不会白跑测试 */
  const opts: FixOpts = {
    autoRetry: branch !== "edit",
    requireConfirm: branch === "edit",
    deferBaseline: branch !== "fix",
  };
  const res = await ses.fix(body, opts);
  console.log(describe(res));
  if (res.changedFiles.length && !res.rolledBack) {
    const summary = renderSummary(buildDiffs(await res.workspace.changes()));
    if (summary) console.log(`\n${summary}`);
  }
  // 耗时统计：任务超过 20 秒才显示（AGENT_STATS=1 则总是显示），回答"时间花在哪了"
  if (res.timing && (ALWAYS_STATS || res.elapsedMs > 20_000)) console.log(`\n${res.timing}`);
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
    try { await handle(ses, argTask); } finally { rl?.close(); ses.dispose(); }
    return;
  }

  printBanner(ses);

  // Ctrl+C：任务运行中 → 只中断任务；空闲时 → 退出
  rl!.on("SIGINT", () => {
    if (ses.interrupt()) {
      console.log("\n[中断] 正在停止当前任务…");
    } else {
      ses.dispose();
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
      if (input === "/reset") { await ses.resetHistory(); console.log("对话已清空"); continue; }
      if (input === "/plan") { console.log(ses.describeState()); continue; }
      if (input === "/jobs") { console.log(ses.describeJobs()); continue; }
      if (input === "/skills") { console.log(await ses.describeSkills()); continue; }
      if (input === "/mcp" || input === "/mcp reload") { console.log(await ses.describeMcp(input.endsWith("reload"))); continue; }
      if (input === "/resume") {
        const n = await ses.resume();
        console.log(n ? `已恢复上次对话（${n} 条消息，${ses.turns} 轮提问）` : "没有可恢复的对话。");
        continue;
      }
      if (input.startsWith("/model ")) {
        ses.model = input.slice(7).trim();     // 只改本会话；所有 LLM 调用都读 ses.model
        console.log(`已切换模型：${ses.model}`);
        continue;
      }
      if (input.startsWith("/cd ")) {
        try { console.log(`已切换目录：${ses.chdir(input.slice(4).trim())}（对话/撤销点/授权已重置；可 /resume 恢复该目录上次的对话）`); }
        catch (e: any) { console.log(e.message); }
        continue;
      }
      if (input === "/diff" || input.startsWith("/diff ")) { await handleDiff(ses, input.slice(5)); continue; }
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
    ses.dispose();
    rl!.close();
  }
}

process.on("unhandledRejection", (e) => { console.error("[unhandledRejection]", e); });
main().catch((e) => { console.error(e); process.exit(1); });
