import "dotenv/config";

export const MODEL = process.env.AGENT_MODEL ?? "gpt-4o-mini";
export const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 40);

/**
 * 这里没有工作目录：目录属于 Session（起点是启动时的 process.cwd()，运行中用 /cd 切换），
 * 各模块都通过参数接收 root，不存在"全局根目录"。
 * MODEL 只是新建 Session 时的初始模型；运行期以 Session.model 为准（/model 修改的就是它）。
 */

export const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out",
  "coverage", ".venv", "__pycache__", ".cache", ".agent",
]);

export const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".py", ".go", ".rs",
  ".java", ".c", ".h", ".cpp", ".sh", ".yml", ".yaml", ".toml",
  ".css", ".html", ".sql",
]);

export const TOOL_OUTPUT_CAP = 20000;
export const ERROR_DIGEST = 6000;
export const MANIFEST_TTL_MS = 24 * 3600000;
export const MAX_RETRIES = 3;

/* ---- 稳健性相关 ---- */
/** 单次 LLM 请求失败（429/5xx/网络）时的最大重试次数 */
export const LLM_MAX_RETRIES = Number(process.env.AGENT_LLM_RETRIES ?? 4);
/** 单次 LLM 请求超时 */
export const LLM_TIMEOUT_MS = Number(process.env.AGENT_LLM_TIMEOUT_MS ?? 120_000);
/** messages 总字符预算，超出后折叠较早的工具输出（约 1 token ≈ 3~4 字符） */
export const CONTEXT_CHAR_BUDGET = Number(process.env.AGENT_CONTEXT_CHARS ?? 220_000);
/** 验证命令超时 */
export const VERIFY_TIMEOUT_MS = Number(process.env.AGENT_VERIFY_TIMEOUT_MS ?? 90_000);
