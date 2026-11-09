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
/**
 * 主循环的 LLM 调用默认用流式响应，所以"超时"不再是整个响应的总时长（写一个几百行的训练脚本本来就要几分钟），
 * 而是三道独立的看门狗：
 */
/** 首个数据块之前最多等多久（推理模型 / 长上下文首包可能很慢） */
export const LLM_FIRST_TOKEN_MS = Number(process.env.AGENT_LLM_FIRST_TOKEN_MS ?? 180_000);
/** 已经开始输出后，两个数据块之间最长静默；超过 = 连接卡死 */
export const LLM_IDLE_MS = Number(process.env.AGENT_LLM_IDLE_MS ?? 60_000);
/** 单次响应的总时长硬上限 */
export const LLM_TOTAL_MS = Number(process.env.AGENT_LLM_TOTAL_MS ?? 900_000);
/** AGENT_LLM_STREAM=0 关闭流式（网关不支持 stream 时用；也会在探测到不支持时自动降级） */
export const LLM_STREAM = process.env.AGENT_LLM_STREAM !== "0";
/** 慢操作（等模型、跑验证、评审）的进度提示间隔：长时间没有输出时每隔这么久打印一行 */
export const HEARTBEAT_MS = Number(process.env.AGENT_HEARTBEAT_MS ?? 10_000);
/**
 * 附加到每个聊天请求体的额外字段（JSON）。典型用途：关闭推理模型的"思考"以大幅降低每步延迟，
 * 例如智谱 GLM：AGENT_EXTRA_BODY='{"thinking":{"type":"disabled"}}'
 */
export const EXTRA_BODY: Record<string, unknown> = (() => {
  const raw = process.env.AGENT_EXTRA_BODY;
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    console.error("[config] AGENT_EXTRA_BODY 不是合法 JSON，已忽略");
    return {};
  }
})();
/** 历史里较早的 write_file/edit_file 大参数从这个占比开始提前折叠（占 CONTEXT_CHAR_BUDGET 的比例）：文件已在磁盘上，没必要每步都重发 */
export const EARLY_FOLD_RATIO = Number(process.env.AGENT_EARLY_FOLD_RATIO ?? 0.25);
/** 任务结束后总是打印耗时统计（默认只在总用时超过 20 秒时打印） */
export const ALWAYS_STATS = process.env.AGENT_STATS === "1";
/** messages 总字符预算，超出后折叠较早的工具输出（约 1 token ≈ 3~4 字符） */
export const CONTEXT_CHAR_BUDGET = Number(process.env.AGENT_CONTEXT_CHARS ?? 220_000);
/** 验证命令超时 */
export const VERIFY_TIMEOUT_MS = Number(process.env.AGENT_VERIFY_TIMEOUT_MS ?? 90_000);
