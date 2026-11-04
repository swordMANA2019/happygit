import type { Workspace } from "../workspace.js";
import type { FileOp } from "../policy.js";
import type { Approval } from "../ui/confirm.js";
import type { AgentMode } from "../llm.js";
import type { TaskState } from "../taskstate.js";
import type { JobManager } from "./jobs.js";
import type { McpManager } from "../mcp.js";

export type ApproveFn = (ops: FileOp[]) => Promise<Approval>;

/**
 * 每次工具调用携带的会话上下文。
 * 工具层不再读任何模块级全局（旧实现：process.cwd()/ROOT 常量、"当前 workspace" 单例、
 * AGENT_READONLY 环境变量），所以多个 Session 可以同时运行且互不串扰。
 */
export type ToolCtx = {
  root: string;
  sessionId: string;
  mode: AgentMode;
  /** 用户已授权"只读访问"的项目外目录（会话级，跨回合保留；其下所有文件都可读） */
  extraRoots: Set<string>;
  /** 首次读取项目外的某个目录时征求用户同意；缺省 = 非交互（除非 --yes，否则拒绝） */
  askExternal?: (dir: string) => Promise<boolean>;
  /** 本次任务的原始描述（用于风险评分里的"是否被提及"） */
  task: string;
  workspace: Workspace;
  /** 交互确认；缺省 = 非交互环境（需要确认的操作会被拒绝并告知模型） */
  approve?: ApproveFn;
  /** 本会话已授权的文件（用户选了 always） */
  approved: Set<string>;
  signal?: AbortSignal;
  /** 计划与工作笔记（update_plan / save_notes 读写它） */
  state: TaskState;
  /** 当前模型（子 Agent 沿用） */
  model: string;
  /** 后台任务（长命令）管理器：会话级，跨回合保留 */
  jobs: JobManager;
  /** 外部工具（MCP）；没有配置则为空 */
  mcp?: McpManager;
  /** 本次任务中加载过的技能（用于完成后执行技能声明的验证） */
  usedSkills: Set<string>;
  /** view_image 排队等待附加到下一条消息的图片 */
  pendingImages: Array<{ path: string; dataUrl: string }>;
  /** 子 Agent 深度：>0 时不能再 delegate；输出静默 */
  depth: number;
  /**
   * 第一次真正写文件之前调用（文件此刻仍是原样）。返回的文本会附在这次写入的结果后面回给模型。
   * 用来把"修改前基线验证"延后到确实要改代码时才做：纯问答/分析的对话不会白跑一遍测试。
   */
  beforeWrite?: () => Promise<string | void>;
};
