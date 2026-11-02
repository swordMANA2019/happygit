/**
 * 失败分类：区分"环境坏了"和"代码错了"。
 *
 * 这是整个 Agent 稳健性的核心：
 *   - code  → 把原文喂回模型，让它改代码重试
 *   - env   → 模型改代码也没用（命令不存在、依赖没装、没网、没权限），
 *             必须停止烧重试次数，把验证器标记为"不可用"并如实告知用户
 *   - timeout → 结论不确定（既不能证明对，也不能证明错）
 */

export type FailureKind = "env" | "timeout" | "code";

export type FailureInfo = { kind: FailureKind; reason: string };

export type RawResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  spawnError?: string;
};

/** 命令不存在 / 权限 / 磁盘 / 网络 —— 与业务代码无关 */
const ENV_PATTERNS: Array<[RegExp, string]> = [
  [/command not found/i, "命令不存在"],
  [/is not recognized as an internal or external command/i, "命令不存在（Windows）"],
  [/不是内部或外部命令/, "命令不存在（Windows）"],
  [/(^|\n)\s*(sh|bash|zsh): .*: not found/i, "命令不存在"],
  [/\bENOENT\b.*\bspawn\b|\bspawn\b.*\bENOENT\b/i, "可执行文件不存在"],
  [/\bEACCES\b|permission denied/i, "权限不足"],
  [/\bENOSPC\b|no space left on device/i, "磁盘空间不足"],
  [/\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b/, "网络不可用"],
  [/could not resolve host|network is unreachable|unable to access 'https?:/i, "网络不可用"],
  [/no test specified/i, "项目没有配置测试脚本"],
  [/npm (ERR!|error) code (E404|ENOTFOUND|EAI_AGAIN)/i, "npm 仓库不可达"],
  [/is not a git repository|not a git repository/i, "不在 git 仓库内"],
  [/dubious ownership/i, "git 目录归属校验失败"],
];

/** 退出码层面的"命令没跑起来" */
const ENV_EXIT_CODES: Record<number, string> = {
  126: "命令存在但不可执行",
  127: "命令不存在",
  9009: "命令不存在（Windows cmd）",
};

export function classifyFailure(r: RawResult): FailureInfo {
  if (r.timedOut) return { kind: "timeout", reason: "执行超时" };
  if (r.spawnError) return { kind: "env", reason: `无法启动进程：${r.spawnError}` };
  if (r.code != null && ENV_EXIT_CODES[r.code]) return { kind: "env", reason: ENV_EXIT_CODES[r.code] };

  const text = `${r.stderr}\n${r.stdout}`;
  for (const [re, reason] of ENV_PATTERNS) {
    if (re.test(text)) return { kind: "env", reason };
  }
  return { kind: "code", reason: "命令返回非零退出码" };
}

/* ---- LLM API 错误分类 ---- */

export type LlmErrorInfo = {
  retryable: boolean;
  contextOverflow: boolean;
  /** 服务端建议的等待毫秒数（Retry-After） */
  retryAfterMs?: number;
  message: string;
};

export function classifyLlmError(e: any): LlmErrorInfo {
  const status: number | undefined = e?.status ?? e?.response?.status;
  const code: string = String(e?.code ?? e?.error?.code ?? "");
  const msg: string = String(e?.message ?? e);

  const contextOverflow =
    code === "context_length_exceeded" ||
    /context length|maximum context|too many tokens|token limit|超出.*长度|上下文.*超/i.test(msg);

  const retryAfterHeader = e?.headers?.["retry-after"] ?? e?.headers?.get?.("retry-after");
  const retryAfterSec = Number(retryAfterHeader);
  const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : undefined;

  const networkCodes = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"];
  const isNetwork =
    networkCodes.includes(code) ||
    e?.name === "APIConnectionError" ||
    e?.name === "APIConnectionTimeoutError" ||
    /ECONNRESET|socket hang up|fetch failed|network|timed? ?out/i.test(msg);

  const retryable =
    !contextOverflow &&
    (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500) || (status === undefined && isNetwork));

  let hint = msg;
  if (status === 401 || status === 403) hint = `鉴权失败（${status}），请检查 OPENAI_API_KEY：${msg}`;
  else if (status === 404) hint = `模型或接口不存在（404），请检查 AGENT_MODEL / OPENAI_BASE_URL：${msg}`;
  else if (status === 429) hint = `请求被限流或额度用尽（429）：${msg}`;

  return { retryable, contextOverflow, retryAfterMs, message: hint };
}
