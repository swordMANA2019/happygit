import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runTask } from "./agent.js";
import { buildContext } from "./context.js";
import { runFixTask, type FixOpts } from "./fix.js";
import { diagnose } from "./diagnose.js";
import { route, type Mode } from "./router.js";
import { ensureManifest, invalidateManifest } from "./probe.js";
import { MODEL, ROOT } from "./config.js";

/* ---- 工具函数 ---- */

function printBanner() {
  console.log(`Mini Agent | 模型：${MODEL} | 根目录：${ROOT}`);
  console.log("命令：/fix <任务> 强制修复 | /edit 只改不重试 | /ask 只问答");
  console.log("      /diag 诊断模式 | /probe 重探验证器 | /context 查看上下文");
  console.log("      /model <名> 切换模型 | /reset 清空历史 | /exit 退出");
}

/** 打印诊断报告，并让用户选择要修哪几条 */
async function askWhichToFix(rl: readline.Interface, report: string): Promise<string | null> {
  console.log(`\n${report}`);
  while (true) {
    const ans = (await rl.question("\n要修复哪些？输入编号（如 1,3）／y 全部／n 放弃：")).trim().toLowerCase();
    if (ans === "n" || ans === "no") return null;
    if (ans === "y" || ans === "yes" || ans === "") return "__all__";
    if (/^\d[\d,\s]*$/.test(ans)) return ans;
    console.log("无法识别，请输入编号、y 或 n。");
  }
}

/** 从诊断报告中抽取第 N 条（简单实现：按行号/序号切分） */
function pickIssues(report: string, spec: string): string {
  const lines = report.split("\n").filter((l) => l.trim());
  const nums = spec.split(/[,，\s]+/).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
  // 粗略策略：把报告按 "## " 分块，取对应块；没有块就原样返回
  const blocks = report.split(/^##\s+/m).filter((b) => b.trim());
  if (blocks.length === 0) return report;
  return nums.map((n) => blocks[n - 1]).filter(Boolean).join("\n## ") || report;
}

/* ---- 主循环 ---- */

async function main() {
  const argTask = process.argv.slice(2).join(" ").trim();

  // CLI 单次调用：直接跑，不走路由
  if (argTask) {
    console.log(await runTask(argTask, await buildContext()));
    return;
  }

  printBanner();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let history: string[] = [];

  try {
    while (true) {
      const input = (await rl.question("\n你> ")).trim();
      if (!input) continue;

      // —— 内置命令（保持你原来的结构） ——
      if (input === "/exit" || input === "/quit") break;
      if (input === "/context") { console.log(await buildContext()); continue; }
      if (input === "/probe") { await invalidateManifest(); console.log(await ensureManifest()); continue; }
      if (input.startsWith("/model ")) { process.env.AGENT_MODEL = input.slice(7).trim(); console.log("已切换模型"); continue; }
      if (input === "/reset") { history = []; console.log("上下文已清空"); continue; }

      // —— 显式模式覆盖：用户说了算，跳过 LLM 路由 ——
      let forced: Mode | null = null;
      let body = input;
      if (input.startsWith("/fix ")) { forced = "fix"; body = input.slice(5).trim(); }
      else if (input.startsWith("/edit ")) { forced = "edit"; body = input.slice(6).trim(); }
      else if (input.startsWith("/ask ")) { forced = "ask"; body = input.slice(5).trim(); }
      else if (input.startsWith("/diag ")) { forced = "diag"; body = input.slice(6).trim(); }

      // —— LLM 意图路由（失败自动降级到关键词） ——
      const r = forced ? { mode: forced, reason: "(forced by command)", missing: [] } : await route(input);
      console.error(`[router] ${r.mode} | ${r.reason}`);

      // 信息不足就先反问，不要瞎猜动手
      if (r.mode === "clarify") {
        console.log(`\n我需要先确认几点才能动手：\n${r.missing.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n补充后重新发送，或直接使用 /fix 强制进入修复模式。`);
        continue;
      }

      // —— ask：纯问答，走原来的路径，记历史 ——
      if (r.mode === "ask") {
        const ctx = await buildContext();
        const memo = history.length ? `此前对话摘要：\n${history.join("\n---\n")}\n\n` : "";
        const answer = await runTask(memo + input, ctx);
        console.log(`\n助手> ${answer}`);
        history.push(`用户：${input}\n助手：${answer}`.slice(0, 2000));
        if (history.length > 5) history.shift();
        continue;
      }

      // —— diag：只读诊断，出报告等人确认 ——
      if (r.mode === "fix" && (forced === "diag" || input.includes("找出") || input.includes("缺陷") || input.includes("问题"))) {
        console.error("[diag] 只读诊断中…");
        const { report, hasRealErrors } = await diagnose(body);
        const which = await askWhichToFix(rl, report);
        if (!which) { console.log("已取消，未做任何修改。"); continue; }
        body = which === "__all__" ? report : pickIssues(report, which);
        // 落到下面的 fix 闭环，逐条修
      }

      // —— edit / fix：统一进验证闭环，参数不同 ——
      const opts: FixOpts = {
        autoRetry: r.mode === "fix",     // fix 自动重试 MAX_RETRIES 次；edit 只跑一轮
        requireConfirm: r.mode === "edit",
      };
      const res = await runFixTask(body, ROOT, opts);
      console.log(res.status === "fixed"
        ? `\n✅ 修复成功（${res.attempts} 轮）\n${res.log}`
        : `\n❌ 修复失败，已回滚到修复前状态\n${res.log}`);

      // 顺手记一笔审计（可选，但强烈建议留着）
      try {
        await import("node:fs/promises").then(async (fs) => {
          const line = JSON.stringify({
            ts: Date.now(), mode: r.mode, task: body.slice(0, 200),
            status: res.status, attempts: res.attempts,
          }) + "\n";
          await fs.mkdir(`${ROOT}/.agent`, { recursive: true });
          await fs.appendFile(`${ROOT}/.agent/fix-log.jsonl`, line);
        });
      } catch {}
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });