import OpenAI from "openai";

export const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  maxRetries: 0, // 重试由 agent.ts 的 callLLM 统一控制（可感知 Retry-After、可中断、可日志）
});

type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

export const READ_TOOL_NAMES = ["read_file", "list_files", "search_code"] as const;
export const WRITE_TOOL_NAMES = ["write_file", "edit_file", "delete_file"] as const;

export const TOOLS: Tool[] = [
  { type: "function", function: {
      name: "read_file",
      description: "读取项目内文件内容。start_line/end_line 为 1-based 闭区间；大文件请分段读取",
      parameters: { type: "object", properties: {
        path: { type: "string" },
        start_line: { type: "number" },
        end_line: { type: "number" },
      }, required: ["path"] } } },
  { type: "function", function: {
      name: "write_file",
      description: "创建或整体覆盖一个文件（修改已有文件优先用 edit_file）",
      parameters: { type: "object", properties: {
        path: { type: "string" }, content: { type: "string" },
      }, required: ["path", "content"] } } },
  { type: "function", function: {
      name: "edit_file",
      description: "对文件做精确文本替换（old_text 必须在文件中唯一匹配；换行风格会自动适配）",
      parameters: { type: "object", properties: {
        path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" },
      }, required: ["path", "old_text", "new_text"] } } },
  { type: "function", function: {
      name: "delete_file",
      description: "删除单个文件（需要用户确认；可被撤销）。不能删除目录",
      parameters: { type: "object", properties: {
        path: { type: "string" },
      }, required: ["path"] } } },
  { type: "function", function: {
      name: "list_files",
      description: "列出目录树（自动忽略 node_modules/.git 等）",
      parameters: { type: "object", properties: {
        path: { type: "string" }, depth: { type: "number" } } } } },
  { type: "function", function: {
      name: "search_code",
      description: "在整个项目中按字面量搜索关键字（匹配文件内容，也匹配文件名），返回 文件:行号:内容。只能搜代码里真实存在的标识符/字符串，不能搜 defect/bug 这类抽象概念",
      parameters: { type: "object", properties: {
        query: { type: "string" }, max_results: { type: "number" } },
        required: ["query"] } } },
  { type: "function", function: {
      name: "run_command",
      description: "在项目根目录执行 shell 命令（编译/测试/lint 等）。stdin 已关闭，不要运行交互式命令；危险命令会被拒绝；超时会杀掉整个进程树",
      parameters: { type: "object", properties: {
        command: { type: "string" },
        cwd: { type: "string", description: "相对项目根目录的工作目录，默认根目录" },
        timeout_ms: { type: "number", description: "超时毫秒数，默认 60000" },
      }, required: ["command"] } } },
];

export type AgentMode = "ask" | "agent";

/** ask 模式只暴露读工具（对应 Cursor 的 Ask 模式）：不是"提示词里说别改"，而是根本拿不到写工具 */
export function toolsFor(mode: AgentMode): Tool[] {
  if (mode === "agent") return TOOLS;
  return TOOLS.filter((t) => (READ_TOOL_NAMES as readonly string[]).includes((t as any).function.name));
}

const COMMON = `你是一个运行在本地代码仓库中的编程 Agent，工作方式参考 Cursor。

工作循环：思考 → 调用工具 → 观察结果 → 继续，直到任务完成。每次调用工具前，用一两句话说明你为什么这样做。

通用规则：
1. 动手前先理解：用 list_files / search_code / read_file 摸清结构与现有约定；优先搜索定位，不要整库乱读。
2. 所有路径相对项目根目录，禁止越界。
3. 环境事实以"运行环境"段落为准：不要假设机器上有 git、bash、grep 等；Windows 下优先用 list_files/read_file/search_code，而不是 ls/cat/grep。
4. 不要执行 git commit / push / reset 等改写仓库状态的命令；回滚由系统检查点负责。
5. 命令失败要先判断性质：
   - 代码问题（编译错误、断言失败）→ 根据原始输出修复；
   - 环境问题（命令不存在、依赖未安装、没网、没权限、超时）→ 这不是代码缺陷，不要改业务代码去规避；
     可以尝试一次合理的补救（如依赖缺失时说明需要安装），否则在总结里明确写出"未能验证及原因"。
6. 不要为了让检查通过而删除/跳过测试、注释报错、吞异常、放宽断言。
7. 工具返回 [已拒绝] / [用户拒绝] / [需要用户确认…] 时，说明该操作被安全策略或用户否决：不要重复同一操作，
   不要换路径绕过（例如读写 .env、node_modules、工作目录之外）；改用其它方案，或在总结里说明阻塞点。
8. 路径写错时工具会给出候选文件，请用候选里的准确相对路径重试。
9. 理解用户想要的结果，而不是字面：先在心里把请求拆成"用户最终想达成什么"，再规划步骤。
   - 用户点名的文件/函数就是目标，先定位并读它；不要把用户说的话当搜索关键字去撞代码。
   - search_code 只做字面量匹配（内容和文件名），只适合搜代码里真实存在的标识符/字符串；
     "有没有问题/优化/怎么实现"这类需要你【阅读并判断】，靠读代码得出结论，而不是靠搜索命中。
   - 复合/条件请求（"先检查，如果有问题就修"）要按顺序全部完成，包括条件成立后的那一步。
10. 下结论要有依据：说"没有问题/找不到"之前，必须已经实际读过相关代码；一次搜索无结果不构成结论，换个角度再查。
11. 对话是连续的：前面回合里的提问、你读过的文件、做过的修改都在上文里。"它/刚才/这个文件/继续/再试一次"指向上文的内容，
    直接沿用，不要让用户重复；若出现 [此前对话的摘要] 或 [系统通知]，同样视为真实发生过的事实（如改动已回滚、用户已 /undo）。`;

const ASK = `${COMMON}

当前为【只读问答模式】：你没有写文件的工具。基于代码给出准确、有依据的回答，引用 文件:行号。`;

const AGENT = `${COMMON}

当前为【自主执行模式】：你拥有完整工具集，并被授权在需要时修改代码。先判断用户这句话要的是什么：
- 只是提问 / 要求解释、分析、审查（"为什么""怎么做""有没有问题"）→ 只读调查，直接回答，不要改任何文件。
- 明确要求修改，或条件式要求（"有问题就修"，且你确认问题存在）→ 动手修改。
- 缺少无法合理假设的关键信息时 → 不要改代码，在回复里直接向用户提一个具体的问题，等待用户下一条消息（对话是连续的）。
执行修改时：
- 不要"先出计划然后询问是否执行"，直接按最小改动完成任务；需求有一般性歧义时写明你的假设再继续。
- 改动要小：优先 edit_file 做精确替换，不要无谓重写整个文件。
- 改完必须验证：用 run_command 跑编译/测试/lint；报错就继续修。
- 若确实无法验证（环境问题），照常完成修改，并在总结中如实说明"未验证"。
- 最终用简洁中文总结：改了哪些文件、为什么、验证结果（通过/失败/未验证）。`;

export function buildSystemPrompt(mode: AgentMode): string {
  return mode === "ask" ? ASK : AGENT;
}

/** 兼容旧引用 */
export const SYSTEM_PROMPT = AGENT;
