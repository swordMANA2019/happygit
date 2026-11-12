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

/** 单个工具结果进入历史的字符上限：它会在之后每一步被重新发送，越大越费 token */
export const TOOL_OUTPUT_CAP = Number(process.env.AGENT_TOOL_OUTPUT_CAP ?? 10000);
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
    if (v && typeof v === "object" && !Array.isArray(v)) {
      console.error(`[config] AGENT_EXTRA_BODY 已生效，每个模型请求都会附加：${JSON.stringify(v)}`);
      return v;
    }
    console.error("[config] AGENT_EXTRA_BODY 必须是 JSON 对象（例如 {\"thinking\":{\"type\":\"disabled\"}}），已忽略");
    return {};
  } catch {
    console.error("[config] AGENT_EXTRA_BODY 不是合法 JSON，已忽略");
    return {};
  }
})();

/**
 * 推理模型的"思考"开关。AGENT_THINKING：
 *   auto（默认）：GLM 系列模型自动关闭思考（thinking.type=disabled）——agent 每一步都要调一次模型，
 *                 每步先思考几十秒是"简单任务 1 分钟、小型训练任务 6 分钟"的主要原因；
 *   on：不干预，由模型默认行为决定（需要深度推理时用）；
 *   off：同 auto 的 GLM 写法，对任何模型都附加（兼容 GLM 接口的网关用）。
 * AGENT_EXTRA_BODY 里显式写了 thinking 字段时，以它为准。
 */
export const THINKING_MODE = (process.env.AGENT_THINKING ?? "auto").toLowerCase();
const thinkingFlag = { broken: false, noticed: false };
const hasUserThinking = "thinking" in EXTRA_BODY;
/** 是否正在由我们自动附加 thinking=disabled（接口拒绝时会被 disableAutoThinking 关掉） */
export function autoThinkingOff(model: string): boolean {
  if (thinkingFlag.broken || hasUserThinking || THINKING_MODE === "on") return false;
  return THINKING_MODE === "off" || /glm/i.test(model);
}
/** 接口不认 thinking 字段（400/422）时调用：之后不再附加，返回是否真的改变了状态（可以重试） */
export function disableAutoThinking(): boolean {
  if (thinkingFlag.broken) return false;
  thinkingFlag.broken = true;
  return true;
}
/** 每个聊天请求要附加的额外字段（用户的 AGENT_EXTRA_BODY + 自动的思考开关） */
export function extraBodyFor(model: string): Record<string, unknown> {
  if (!autoThinkingOff(model)) return EXTRA_BODY;
  if (!thinkingFlag.noticed) {
    thinkingFlag.noticed = true;
    console.error(`[config] 已自动关闭模型思考（${model}）以降低每步延迟；需要深度推理可设 AGENT_THINKING=on`);
  }
  return { thinking: { type: "disabled" }, ...EXTRA_BODY };
}

/**
 * 思考上限（字符）：模型在还没输出任何答案/工具调用之前，思考内容超过这个值就中止这次生成并重试一次
 * （重试时附带"别长时间思考"的临时提示，且不再设上限）。用来兜底"thinking 参数被网关/模型忽略"的情况。0 = 不限制。
 */
export const THINK_MAX_CHARS = Number(process.env.AGENT_THINK_MAX_CHARS ?? 6000);

/** 历史摘要：单次摘要最多生成多少 token（限制输出长度 = 限制耗时） */
export const SUMMARY_MAX_TOKENS = Number(process.env.AGENT_SUMMARY_MAX_TOKENS ?? 1200);
/** 摘要专用模型（可选）：用更快/更便宜的模型做压缩，默认沿用会话模型 */
export const SUMMARY_MODEL = process.env.AGENT_SUMMARY_MODEL || "";
/** 历史摘要的并行度：较早的对话切成最多这么多段，同时发出请求 */
export const SUMMARY_PARALLEL = Math.max(1, Number(process.env.AGENT_SUMMARY_PARALLEL ?? 4));
/** 每回合结束后在后台预先整理历史（下一回合开始时不再等待）。AGENT_BG_COMPACT=0 关闭 */
export const BG_COMPACT = process.env.AGENT_BG_COMPACT !== "0";

/** 历史里较早的 write_file/edit_file 大参数从这个占比开始提前折叠（占 CONTEXT_CHAR_BUDGET 的比例）：文件已在磁盘上，没必要每步都重发 */
export const EARLY_FOLD_RATIO = Number(process.env.AGENT_EARLY_FOLD_RATIO ?? 0.25);
/** 任务结束后总是打印耗时统计（默认只在总用时超过 20 秒时打印） */
export const ALWAYS_STATS = process.env.AGENT_STATS === "1";
/**
 * messages 总字符预算，超出后折叠较早的工具输出（约 1 token ≈ 3~4 字符）。
 * 每一步都会把整份历史重发一遍，所以这个值 ≈ 单步输入 token 的上限：越小越省 token（默认 120k 字符，约 40k token）。
 */
export const CONTEXT_CHAR_BUDGET = Number(process.env.AGENT_CONTEXT_CHARS ?? 120_000);
/** 验证命令超时 */
export const VERIFY_TIMEOUT_MS = Number(process.env.AGENT_VERIFY_TIMEOUT_MS ?? 90_000);
