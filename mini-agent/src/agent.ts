import OpenAI from "openai";
import { client, TOOLS, SYSTEM_PROMPT } from "./llm.js";
import { readFile, writeFile, editFile, listFiles } from "./tools/fs.js";
import { searchCode } from "./tools/search.js";
import { runCommand } from "./tools/shell.js";
import { MAX_STEPS, MODEL , TOOL_OUTPUT_CAP} from "./config.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

async function dispatch(name: string, args: any): Promise<string> {
  try {
    switch (name) {
      case "read_file":   return await readFile(args.path, args.start_line, args.end_line);
      case "write_file":  return await writeFile(args.path, args.content);
      case "edit_file":   return await editFile(args.path, args.old_text, args.new_text);
      case "list_files":  return await listFiles(args.path ?? ".", args.depth ?? 3);
      case "search_code": return await searchCode(args.query, args.max_results ?? 40);
      case "run_command": return await runCommand(args.command, { cwd: args.cwd, timeoutMs: args.timeout_ms });
      default:            return `未知工具：${name}`;
    }
  } catch (e: any) {
    return `工具执行失败：${e.message}`;
  }
}

export async function runTask(task: string, context: string) {
  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${context}\n\n任务：${task}` },
  ];

  for (let step = 1; step <= MAX_STEPS; step++) {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0,
    });

    const msg = resp.choices[0].message;
    messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls } as Msg);

    if (!msg.tool_calls?.length) {
      return msg.content ?? "（无输出）";
    }

    for (const tc of msg.tool_calls) {
      const fn = tc.function.name;
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      console.log(`\n[步骤 ${step}] ${fn} ${JSON.stringify(args).slice(0, 160)}`);
      const result = await dispatch(fn, args);
      console.log(result.slice(0, 300) + (result.length > 300 ? " …" : ""));
      messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, TOOL_OUTPUT_CAP) });
    }
  }
  return "已达到最大步数上限，任务未完成，请拆分后重试。";
}