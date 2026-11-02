// src/index.ts —— 只改头部这几行
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { route, type Mode } from "./router.js";
import { MODEL } from "./config.js";
import { Session } from "./session.js";

type Branch = Mode | "diag";   // diag 是本地流程分支，不属于意图分类

function printBanner(ses: Session) {
  console.log(`Mini Agent | 模型：${ses.model} | 目录：${ses.cwd}`);
  console.log("命令：/fix <任务> | /edit | /ask | /diag | /probe | /context | /model <名> | /reset | /exit");
}

async function askWhichToFix(rl: readline.Interface, report: string): Promise<string | null> {
  console.log(`\n${report}`);
  while (true) {
    const ans = (await rl.question("\n要修复哪些？编号(如 1,3) / y 全部 / n 放弃：")).trim().toLowerCase();
    if (ans === "n" || ans === "no") return null;
    if (ans === "y" || ans === "yes" || ans === "") return "__all__";
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

async function appendAudit(record: unknown) {
  try {
    const dir = path.join(process.cwd(), ".agent");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "fix-log.jsonl"), JSON.stringify(record) + "\n");
  } catch {
    /* ignore */
  }
}

async function main() {
  const ses = new Session(process.cwd(), MODEL);
  const argTask = process.argv.slice(2).join(" ").trim();
  if (argTask) {
    console.log(await ses.ask(argTask, await ses.context()));
    return;
  }

  printBanner(ses);
  
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let history: string[] = [];

  try {
    while (true) {
      const input = (await rl.question("\n你> ")).trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      if (input === "/context") { console.log(await ses.context()); continue; }
      if (input === "/probe") {
        await ses.probe();
        console.log(`已重新探测了${ses.cwd}`);
        continue;
      }
      if (input.startsWith("/model ")) {
        const m = input.slice(7).trim();
        process.env.AGENT_MODEL = m;
        ses.model = m;
        console.log(`已切换模型：${m}`);
        continue;
      }
      if (input === "/reset") {
        history.length = 0;
        console.log("上下文已清空");
        continue;
      }
      if (input === "/pwd") {
        console.log(ses.cwd);
        continue;
      }
      // 显式覆盖：这里允许 "diag"
      let forced: Branch | null = null;
      let body = input;
      if (input.startsWith("/fix ")) {forced = "fix"; body = input.slice(5).trim(); }
      else if (input.startsWith("/edit ")) { forced = "edit"; body = input.slice(6).trim(); }
      else if (input.startsWith("/ask ")) { forced = "ask"; body = input.slice(5).trim(); }
      else if (input.startsWith("/diag ")) { forced = "diag"; body = input.slice(6).trim(); }

      const r = forced ? { mode: forced as Mode, reason: "(forced)", missing: [] } : await route(input);
      const branch: Branch = forced ?? r.mode;
      console.error(`[router] ${branch} | ${r.reason}`);

      if (r.mode === "clarify" && !forced) {
        console.log(`\n我需要先确认几点：\n${r.missing.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n补充后重发，或 /fix 强制进入修复模式。`);
        continue;
      }

      if (branch === "ask") {
        const ctx = await ses.context();
        const memo = history.length ? `此前对话摘要：\n${history.join("\n---\n")}\n\n` : "";
        const answer = await ses.ask(memo + input, ctx);
        console.log(`\n助手> ${answer}`);
        history.push(`用户：${input}\n助手：${answer}`.slice(0, 2000));
        if (history.length > 5) history.shift();
        continue;
      }

      // diag：只读诊断 → 出报告 → 等人选
      if (branch === "diag" || (branch === "fix" && /(找出|缺陷|问题|哪里不对|有什么毛病)/.test(input))) {
        console.error("[diag] 只读诊断中…");
        const { report } = await ses.diagnose(body);
        const which = await askWhichToFix(rl, report);
        if (!which) { console.log("已取消，未做任何修改。"); continue; }
        body = which === "__all__" ? report : pickIssues(report, which);
      }

      // edit/fix 进闭环
      const res = await ses.fix(body, {
        autoRetry: branch === "fix",
        requireConfirm: branch === "edit",
      });

      if (res.status === "fixed") {
        console.log(`\n✅ 修复成功（${res.attempts} 轮）\n${res.log}`);
      } else if (res.status === "denied") {
        console.log("\n⛔ 用户拒绝变更，已回滚");
      } else {
        console.log(`\n❌ 修复失败，已回滚\n${res.log}`);
      }

      await appendAudit({
        ts: Date.now(),
        cwd: ses.cwd,
        branch,
        task: body.slice(0, 200),
        status: res.status,
        attempts: res.attempts,
      });
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });