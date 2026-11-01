import OpenAI from "openai";


export const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  { type: "function", function: {
      name: "read_file",
      description: "读取项目内文件内容，可指定行号范围",
      parameters: { type: "object", properties: {
        path: { type: "string" },
        start_line: { type: "number" },
        end_line: { type: "number" },
      }, required: ["path"] } } },
  { type: "function", function: {
      name: "write_file",
      description: "创建或整体覆盖一个文件",
      parameters: { type: "object", properties: {
        path: { type: "string" }, content: { type: "string" },
      }, required: ["path", "content"] } } },
  { type: "function", function: {
      name: "edit_file",
      description: "对文件做精确文本替换（old_text 必须唯一）",
      parameters: { type: "object", properties: {
        path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" },
      }, required: ["path", "old_text", "new_text"] } } },
  { type: "function", function: {
      name: "list_files",
      description: "列出目录树",
      parameters: { type: "object", properties: {
        path: { type: "string" }, depth: { type: "number" } } } } },
  { type: "function", function: {
      name: "search_code",
      description: "在整个项目中搜索关键字，返回 文件:行号:内容",
      parameters: { type: "object", properties: {
        query: { type: "string" }, max_results: { type: "number" } },
        required: ["query"] } } },
  { type: "function", function: {
      name: "run_command",
      description: "在项目根目录执行 shell 命令（白名单内）",
      parameters: { type: "object", properties: {
        command: { type: "string" } }, required: ["command"] } } },
];

export const SYSTEM_PROMPT = `你是一个运行在本地代码仓库中的编程 Agent，工作方式参考 Cursor。

必须遵守：
1. 动手前先理解：用 list_files / search_code / read_file 摸清项目结构与现有约定。
2. 改动要小：优先用 edit_file 做精确替换，不要无谓重写整个文件。
3. 改完要验证：用 run_command 跑编译、测试或 lint，报错就继续修。
4. 所有路径都相对于项目根目录，禁止越界访问。
5. 需求不明确时先说明你的假设，再继续执行。
6. 最终用简洁中文总结：改了什么文件、为什么、如何验证。
7. 若任务涉及修改代码，必须先输出计划（Markdown）：【诊断】【改动清单】【验证命令】，然后询问用户是否执行。
   得到肯定答复前不得调用 write_file / edit_file。
   若任务只需阅读/解释，不要调用写工具。`;