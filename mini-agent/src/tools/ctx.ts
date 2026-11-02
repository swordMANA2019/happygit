import type { Workspace } from "../workspace.js";
import type { FileOp } from "../policy.js";
import type { Approval } from "../ui/confirm.js";
import type { AgentMode } from "../llm.js";

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
  /** 本次任务的原始描述（用于风险评分里的"是否被提及"） */
  task: string;
  workspace: Workspace;
  /** 交互确认；缺省 = 非交互环境（需要确认的操作会被拒绝并告知模型） */
  approve?: ApproveFn;
  /** 本会话已授权的文件（用户选了 always） */
  approved: Set<string>;
  signal?: AbortSignal;
};
