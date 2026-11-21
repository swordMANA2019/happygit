import fs from "node:fs";
import path from "node:path";
import { defaultDataDir } from "./ui/icon.js";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { INITIAL_MODEL } from "./config.js";
import { PptWatcher, formatWatchEvent } from "@mini-agent/ppt-sdk";
import { pptBackupDir } from "./tools/ppt.js";
import { Session, type Prompter } from "./session.js";
import { printBanner, handle, runBuiltin } from "./commands.js";

/* ---- 主入口 ---- */

async function main() {
  const FLAGS = new Set(["--yes", "--ui", "--cli", "--no-open"]);     // --yes 由 autoAllowed() 单独读取
  const argv = process.argv.slice(2).filter((a) => !FLAGS.has(a));
  const argTask = argv.join(" ").trim();

  // 默认是桌面界面（像普通应用一样双击/直接运行就开窗口）。
  // 终端交互用 --cli（或可执行文件名以 -cli 结尾，或 AGENT_UI=0）；带任务参数（mini-agent "做点什么"）仍是一次性命令行调用。
  const cliMode = process.argv.includes("--cli") || /-cli(\.exe)?$/i.test(process.execPath) || process.env.AGENT_UI === "0";
  if (!cliMode && !argTask) {
    const { runUi } = await import("./server.js");
    await runUi({ open: !process.argv.includes("--no-open") });
    return;
  }

  const interactive = Boolean(stdin.isTTY);
  const rl = interactive || !argTask ? readline.createInterface({ input: stdin, output: stdout }) : null;

  // 全程只有这一个 readline：REPL 输入与"是否应用变更？"确认都走它
  const prompter: Prompter | null = rl
    ? { ask: async (q, signal) => { try { return await rl.question(q, { signal }); } catch { return ""; } } }
    : null;
  const ses = new Session(process.cwd(), INITIAL_MODEL, prompter);
  const watcher = new PptWatcher({
    ppt: ses.ppt,
    backupDir: () => pptBackupDir(ses.cwd),
    busy: () => ses.busy,                                        // agent 在跑任务时不打扰
    pollMs: Number(process.env.AGENT_WATCH_POLL_MS) || undefined,
    debounceMs: Number(process.env.AGENT_WATCH_DEBOUNCE_MS) || undefined,
  });
  // 提示打在用户正在输入的提示符下面，所以补打一个提示符
  const show = (s: string) => { process.stdout.write(`\n${s}\n\n你> `); };
  watcher.on("issues", (e) => show(formatWatchEvent(e)));
  watcher.on("stopped", () => show("[watch] 连续多次无法读取 PowerPoint，已停止监视（/watch ppt 可重新开启）。"));

  // CLI 单次调用：走和 REPL 同一条路径，保证有检查点/验证/回滚
  if (argTask) {
    try { await handle(ses, argTask); }
    catch (e: any) { console.error(`\n[错误] ${e?.message ?? e}`); process.exitCode = 1; }   // 单次调用的失败（如 CURSOR_API_KEY 无效）只显示原因，不打印堆栈
    finally { rl?.close(); ses.dispose(); }
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

      // —— 内置命令（与 Web 界面共用同一份实现，见 commands.ts）——
      const r = await runBuiltin(ses, watcher, input);
      if (r === "exit") break;
      if (r === "handled") continue;

      try {
        await handle(ses, input);
      } catch (e: any) {
        // 单条任务的异常不应让整个会话退出
        console.error(`\n[错误] ${e?.message ?? e}`);
      }
    }
  } finally {
    watcher.stop();
    ses.dispose();
    rl!.close();
  }
}

process.on("unhandledRejection", (e) => { console.error("[unhandledRejection]", e); });
main().catch((e) => {
  console.error(e);
  // 界面版（Windows 上没有控制台窗口）启动失败时没人看得到 stderr：留一份日志
  try {
    const dir = path.join(defaultDataDir(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "startup-error.log"), `[${new Date().toISOString()}] ${e?.stack ?? e}\n`);
  } catch { /* 写不了日志也不能影响退出 */ }
  process.exit(1);
});
