import fs from "node:fs/promises";
import path from "node:path";
import { ALWAYS_STATS, VISION_MODEL, BACKEND, resolveModel } from "./config.js";
import { PptWatcher, formatApplyResult } from "@mini-agent/ppt-sdk";
import { pptAvailable, pptErr } from "./tools/ppt.js";
import { Session } from "./session.js";
import { say, sayWithLog } from "./trace.js";
import type { FixResult, FixOpts } from "./fix.js";
import {
  buildDiffs, renderSummary, renderFileDiff, pickDiffs, writeHtml, openExternal, openInIde, type FileDiff,
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

/**
 * 命令层与"界面"之间唯一的差异点。终端（REPL）不需要提供任何东西；Web 界面提供 showDiffs，
 * 用页面里的 diff 视图替代终端里的交互式查看器 / 外部浏览器。
 */
export type CommandEnv = {
  showDiffs?: (diffs: FileDiff[], title: string) => Promise<void>;
};

/* ---- 展示 ---- */

export function printBanner(ses: Session) {
  console.log(`Mini Agent | 模型：${ses.model} | 目录：${ses.cwd} | session：${ses.sessionId}`);
  if (BACKEND === "cursor") {
    console.log(`      后端：Cursor Agent（任务交给 Cursor 执行；${process.env.CURSOR_API_KEY ? "已设置 CURSOR_API_KEY" : "⚠ 未设置 CURSOR_API_KEY"}）。/ask /diag /undo /diff /ppt 可用；/plan /jobs /skills /mcp /probe 不适用。`);
  }
  console.log("直接输入即可（Agent 模式：自行判断回答或修改）。命令：/ask <问题> 只读问答 | /fix <任务> | /edit <任务> | /diag <任务> | /undo | /diff [编号|html|ide] 高亮查看改动");
  console.log("      /plan 计划与笔记 | /jobs 后台任务 | /skills 技能 | /mcp [reload] 外部工具 | /resume 恢复上次对话 | /reset 清空对话 | /probe | /context | /cd <目录> | /pwd | /model <名> | /exit   （任务运行中 Ctrl+C 可中断）");
  if (pptAvailable()) console.log("      PowerPoint：直接说“把这页的标题放大/插一朵花”即可操作你正打开的 PPT | /ppt 状态 | /ppt review 评审当前页 | /watch ppt [off] 实时建议 | /apply [编号] 执行自动修复");
}

/* ---- PowerPoint：/ppt /watch /apply ---- */

async function handlePpt(ses: Session, arg: string): Promise<void> {
  if (!pptAvailable()) { say("PowerPoint 控制不可用：需要 Windows + 桌面版 PowerPoint（AGENT_PPT=0 会关闭，AGENT_PPT=1 强制开启）。"); return; }
  if (arg === "review") {
    ses.armPpt();
    await handle(ses, "/ask 请评审我在 PowerPoint 里当前正看着的这一页：先 ppt_read 读取实时内容，再 ppt_lint，若 ppt_look 可用也看一眼渲染图；然后按优先级给出最多 5 条具体建议（指明形状和改法）。不要修改任何内容，等我确认后再改。");
    return;
  }
  try {
    const st = await ses.ppt.state();
    if (!st.running) { say("PowerPoint 没有运行。直接对我说“新建一个关于…的 PPT”，或先手动打开一个文稿。"); return; }
    if (!st.active) { say("PowerPoint 已运行，但没有打开的演示文稿。"); return; }
    const sel = st.selection;
    say(`文稿：${st.active}${st.saved ? "" : "（有未保存修改）"} | 共 ${st.slideCount} 页 | 当前第 ${st.activeSlide} 页 | ${st.slideWidth}x${st.slideHeight}pt` +
      `\n选中：${!sel || sel.type === "none" ? "无" : sel.type === "shapes" ? sel.shapes?.map((s) => s.name).join("、") : sel.type === "slides" ? `缩略图第 ${sel.slides?.join("、")} 页` : "一段文字"}` +
      `\n视觉点评：${VISION_MODEL ? `${VISION_MODEL}（ppt_look）` : process.env.AGENT_VISION === "1" ? "主模型看图（AGENT_VISION=1）" : "未配置（设置 AGENT_VISION_MODEL 后 ppt_look 才可用）"}`);
  } catch (e: any) { say(`[PowerPoint] ${e?.message ?? e}`); }
}

async function handleWatch(ses: Session, watcher: PptWatcher, arg: string): Promise<void> {
  if (!pptAvailable()) { say("PowerPoint 控制不可用（需要 Windows + 桌面版 PowerPoint）。"); return; }
  const a = arg.replace(/^ppt\b\s*/i, "").trim().toLowerCase();
  if (a === "off" || a === "stop") { watcher.stop(); say("已停止监视 PowerPoint。"); return; }
  if (a === "" && watcher.running) { say("正在监视 PowerPoint（/watch ppt off 停止）。"); return; }
  ses.armPpt();
  watcher.start();
  say("已开始监视 PowerPoint：你在 PowerPoint 里改动并停手约 3 秒后，我会按规则检查当前页（出界/重叠/字号/对比度/溢出/对齐…，不花 token）并只提示新问题。\n/apply 执行自动修复，/ppt review 让我整体评审，/watch ppt off 停止。");
}

function describe(res: FixResult): string {
  const files =
    (res.changedFiles.length ? `\n改动文件：\n  ${res.changedFiles.join("\n  ")}` : "") +
    (res.produced.length ? `\n脚本产出/修改的文件（不在检查点里，/undo 无法还原）：\n  ${res.produced.slice(0, 20).join("\n  ")}` : "");
  const answer = res.answer ? `\n助手> ${res.answer}\n` : "";
  switch (res.status) {
    case "fixed":
      return `${answer}\n✅ 修改完成（${res.attempts} 轮，验证通过）${files}\n（不满意可输入 /undo 撤销）`;
    case "selftested":
      return `${answer}\n✅ 修改完成，并通过【模型黑盒自测】（项目没有自带验证器；结论取决于上面“验证”一节里的实际运行证据）${files}\n（不满意可输入 /undo 撤销）`;
    case "unverified":
      return `${answer}\n⚠️  已完成修改，但【未能自动验证】（详见 warnings）${files}\n（可输入 /undo 撤销）`;
    case "no_change":
      // 最常见的是纯问答/分析回合：答案就是结果，不需要任何"没有修改"的噪音
      return `${answer}` +
        (res.produced.length ? `\n（运行期间项目里新增/变化的文件，可能来自脚本或后台任务：\n  ${res.produced.slice(0, 10).join("\n  ")}${res.produced.length > 10 ? `\n  …共 ${res.produced.length} 个` : ""}）` : "") +
        (res.warnings.length ? `\n[warnings]\n- ${res.warnings.join("\n- ")}` : "");
    case "aborted":
      return `${answer}\n⏹  已中断，当前改动已保留${files}\n（输入 /undo 可撤销）`;
    case "failed":
      return res.rolledBack
        ? `${answer}\n❌ 任务失败，所有改动已回滚到修改前状态`
        : `${answer}\n❌ 任务失败${res.changedFiles.length ? "，改动已按配置保留" : ""}${files}`;
  }
}

/** 打印诊断报告，并让用户选择要修哪几条 */
async function askWhichToFix(ses: Session, report: string): Promise<string | null> {
  say(`\n${report}`);
  while (true) {
    const ans = ((await ses.prompter?.ask("\n要修复哪些？编号(如 1,3) / y 全部 / n 放弃：")) ?? "n").trim().toLowerCase();
    if (ans === "n" || ans === "no" || ans === "") return null;
    if (ans === "y" || ans === "yes") return "__all__";
    if (/^\d[\d,\s]*$/.test(ans)) return ans;
    say("无法识别，请输入编号、y 或 n。");
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
async function handleDiff(ses: Session, arg: string, env: CommandEnv = {}): Promise<void> {
  const diffs = await ses.lastDiffs();
  if (!diffs) { say("没有可查看的改动（最近一次任务没有修改文件，或已被 /undo 撤销）。"); return; }

  const m = /^(print|vim|html|ide)\b\s*(.*)$/i.exec(arg.trim());
  const mode = m ? m[1].toLowerCase() : "view";
  const sel = m ? m[2] : arg;

  const picked = pickDiffs(diffs, sel);
  if (typeof picked === "string") { say(picked); return; }

  if (env.showDiffs && (mode === "view" || mode === "html")) {
    await env.showDiffs(picked, `本次任务改动了 ${picked.length} 个文件`);
    return;
  }
  if (mode === "view") {
    // 没指定文件 → 从文件列表开始；指定了 → 直接进入该文件
    await runDiffViewer(sel.trim() && sel.trim() !== "all" ? picked : diffs, sel.trim() && sel.trim() !== "all" && picked.length === 1 ? 0 : undefined);
    return;
  }
  if (mode === "vim") {
    if (!(await openInVim(ses.sessionId, picked))) {
      say("没有找到 vim（Windows 默认没有），改用内置查看器。");
      await runDiffViewer(picked);
    }
    return;
  }

  if (mode === "html") {
    const file = await writeHtml(ses.cwd, picked);
    const opened = await openExternal(file);
    say(opened ? `已在浏览器中打开：${file}` : `已生成：${file}\n（当前环境无法自动打开浏览器；用 Cursor/VS Code 或浏览器打开该文件即可，每个文件点击标题展开）`);
    return;
  }
  if (mode === "ide") {
    const r = await openInIde(ses.sessionId, picked);
    say(r.note);
    return;
  }
  for (const d of picked) say(`\n${renderFileDiff(d)}`);
}

/* ---- 单条输入的处理（REPL 与单次调用共用） ---- */

export async function handle(ses: Session, input: string): Promise<void> {
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
    say(`\n助手> ${out.status === "done" ? "" : `[${out.status}] `}${out.text}`);
    return;
  }

  /* ---- diag：用户显式要求 → 只读诊断 → 出报告 → 等人选 ---- */
  if (branch === "diag") {
    if (!ses.prompter) { say("诊断模式需要交互确认，请在交互终端中使用。"); return; }
    console.error("[diag] 只读诊断中…");
    const { report } = await ses.diagnose(body);
    const which = await askWhichToFix(ses, report);
    if (!which) { say("已取消，未做任何修改。"); return; }
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
  sayWithLog(describe(res), res.log);
  if (res.changedFiles.length && !res.rolledBack) {
    const summary = renderSummary(buildDiffs(await res.workspace.changes()));
    if (summary) say(`\n${summary}`);
  }
  // 耗时统计：任务超过 20 秒才显示（AGENT_STATS=1 则总是显示），回答"时间花在哪了"
  if (res.timing && (ALWAYS_STATS || res.elapsedMs > 20_000)) console.log(`\n${res.timing}`);
  await appendAudit(ses, {
    cwd: ses.cwd, branch, task: body.slice(0, 200),
    status: res.status, attempts: res.attempts, files: res.changedFiles, warnings: res.warnings.length,
  });
}

/**
 * 内置斜杠命令（终端 REPL 与 Web 界面共用）。
 * 返回 "exit" = 退出；"handled" = 已处理；"none" = 不是内置命令，交给 handle() 当作任务。
 */
export async function runBuiltin(ses: Session, watcher: PptWatcher, input: string, env: CommandEnv = {}): Promise<"exit" | "handled" | "none"> {
  if (input === "/exit" || input === "/quit") return "exit";
  if (input === "/context") { say(await ses.context()); return "handled"; }
  if (input === "/pwd") { say(ses.cwd); return "handled"; }
  if (input === "/probe") { await ses.probe(); say(`已重新探测了 ${ses.cwd}`); return "handled"; }
  if (input === "/reset") { await ses.resetHistory(); say("对话已清空"); return "handled"; }
  if (input === "/plan") { say(ses.describeState()); return "handled"; }
  if (input === "/jobs") { say(ses.describeJobs()); return "handled"; }
  if (input === "/skills") { say(await ses.describeSkills()); return "handled"; }
  if (input === "/mcp" || input === "/mcp reload") { say(await ses.describeMcp(input.endsWith("reload"))); return "handled"; }
  if (input === "/resume") {
    const n = await ses.resume();
    say(!n ? "没有可恢复的对话。" : ses.backend === "cursor" ? "已恢复上次的 Cursor Agent 对话（上下文由 Cursor 保存，下一条消息起生效）。" : `已恢复上次对话（${n} 条消息，${ses.turns} 轮提问）`);
    return "handled";
  }
  if (input.startsWith("/model ")) {
    const pick = resolveModel(input.slice(7), ses.backend);       // 模型决定后端；只改本会话，所有 LLM 调用都读 ses.model
    ses.useModel(pick.id, pick.backend);
    say(`已切换模型：${ses.model}（${ses.backend === "cursor" ? "Cursor Agent" : "OpenAI 兼容接口"}）`);
    return "handled";
  }
  if (input.startsWith("/cd ")) {
    try { say(`已切换目录：${ses.chdir(input.slice(4).trim())}（对话/撤销点/授权已重置；可 /resume 恢复该目录上次的对话）`); }
    catch (e: any) { say(e.message); }
    return "handled";
  }
  if (input === "/ppt" || input.startsWith("/ppt ")) {
    try { await handlePpt(ses, input.slice(4).trim().toLowerCase()); } catch (e: any) { say(`\n[错误] ${e?.message ?? e}`); }
    return "handled";
  }
  if (input === "/watch" || input.startsWith("/watch ")) { await handleWatch(ses, watcher, input.slice(6).trim()); return "handled"; }
  if (input === "/apply" || input.startsWith("/apply ")) {
    try { say(formatApplyResult(await watcher.apply(input.slice(6)))); } catch (e: any) { say(pptErr(e)); }
    return "handled";
  }
  if (input === "/diff" || input.startsWith("/diff ")) { await handleDiff(ses, input.slice(5), env); return "handled"; }
  if (input === "/undo") {
    const files = await ses.undo();
    say(files === null ? "没有可撤销的改动。" :
      files.length ? `已撤销，还原了 ${files.length} 个文件：\n  ${files.join("\n  ")}` : "没有需要还原的文件。");
    return "handled";
  }
  return "none";
}
