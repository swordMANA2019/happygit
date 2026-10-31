import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runTask } from "./agent.js";
import { buildContext } from "./context.js";
import { MODEL, ROOT } from "./config.js";

async function main() {
  const argTask = process.argv.slice(2).join(" ").trim();
  console.log(`Mini Agent | 模型：${MODEL} | 根目录：${ROOT}`);

  if (argTask) {
    console.log(await runTask(argTask, await buildContext()));
    return;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let history: string[] = [];

  while (true) {
    const input = (await rl.question("\n你> ")).trim();
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;
    if (input === "/context") { console.log(await buildContext()); continue; }
    if (input.startsWith("/model ")) { process.env.AGENT_MODEL = input.slice(7); console.log("已切换模型"); continue; }
    if (input === "/reset") { history = []; console.log("上下文已清空"); continue; }

    const ctx = await buildContext();
    const memo = history.length
      ? `此前对话摘要：\n${history.join("\n---\n")}\n\n` : "";
    const answer = await runTask(memo + input, ctx);
    console.log(`\n助手> ${answer}`);
    history.push(`用户：${input}\n助手：${answer}`.slice(0, 2000));
    if (history.length > 5) history.shift();
  }
  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });