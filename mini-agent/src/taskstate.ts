/**
 * 任务状态：计划（plan）+ 工作笔记（notes）。
 *
 * 为什么需要它：Agent 要处理的不只是"改一个文件"，还可能是"读完一堆资料写 PPT""整理一场会议"。
 * 这类任务的"全局视图"不是某种目录结构，而是：我要达成什么、已经做了什么、还剩什么、目前学到了什么。
 *
 * 设计要点：
 *  - 它不属于对话消息：每一步都被重新注入系统提示词的末尾，所以历史被折叠/摘要后，计划和笔记依然完整可见。
 *  - 由模型自己通过 update_plan / save_notes 工具维护——"要不要通读全部资料、读到什么程度"是模型根据计划做的判断，
 *    而不是代码里的关键字规则。
 *  - 与领域无关：代码、文档、会议纪要、数据分析……用的是同一套机制。
 *  - 纯内存状态、不写用户的项目文件；随对话一起落盘（见 memory.ts），/resume 时一并恢复。
 */

export type StepStatus = "pending" | "in_progress" | "done";
export type PlanStep = { content: string; status: StepStatus };

export type TaskState = {
  goal: string;
  steps: PlanStep[];
  notes: string;
};

const MAX_STEPS_IN_PLAN = 20;
const MAX_STEP_CHARS = 200;
const MAX_GOAL_CHARS = 400;
export const MAX_NOTES_CHARS = 6000;

export const emptyState = (): TaskState => ({ goal: "", steps: [], notes: "" });

export function resetState(s: TaskState): void {
  s.goal = ""; s.steps = []; s.notes = "";
}

export function loadState(into: TaskState, from: Partial<TaskState> | undefined): void {
  resetState(into);
  if (!from) return;
  into.goal = typeof from.goal === "string" ? from.goal : "";
  into.notes = typeof from.notes === "string" ? from.notes : "";
  into.steps = Array.isArray(from.steps)
    ? from.steps.filter((x) => x && typeof x.content === "string").map(normalizeStep)
    : [];
}

function normalizeStep(x: any): PlanStep {
  const status: StepStatus = x?.status === "done" || x?.status === "in_progress" ? x.status : "pending";
  return { content: String(x?.content ?? "").slice(0, MAX_STEP_CHARS), status };
}

const MARK: Record<StepStatus, string> = { pending: "[ ]", in_progress: "[▶]", done: "[✓]" };

/** 给人和模型都看得懂的计划文本 */
export function renderPlan(s: TaskState): string {
  if (!s.goal && s.steps.length === 0) return "";
  const lines: string[] = [];
  if (s.goal) lines.push(`目标：${s.goal}`);
  s.steps.forEach((st, i) => lines.push(`${MARK[st.status]} ${i + 1}. ${st.content}`));
  return lines.join("\n");
}

/** 注入系统提示词末尾的块；没有任何内容时返回空串（不给简单对话添噪音） */
export function renderStateBlock(s: TaskState): string {
  const plan = renderPlan(s);
  if (!plan && !s.notes) return "";
  const parts = ["## 当前任务状态（由你通过 update_plan / save_notes 维护；每一步都会重新显示在这里）"];
  if (plan) parts.push(`### 计划\n${plan}`);
  if (s.notes) parts.push(`### 工作笔记\n${s.notes}`);
  return `\n\n${parts.join("\n\n")}`;
}

/* ---- 工具实现：永不抛异常，错误以文本回给模型 ---- */

export function updatePlan(s: TaskState, args: any): string {
  if (!Array.isArray(args?.steps)) return "[参数错误] update_plan：steps 必须是数组，元素形如 {content, status}。";
  if (args.steps.length > MAX_STEPS_IN_PLAN) {
    return `[参数错误] update_plan：步骤过多（${args.steps.length} > ${MAX_STEPS_IN_PLAN}）。请合并成更粗的步骤。`;
  }
  const steps = args.steps
    .filter((x: any) => x && typeof x.content === "string" && x.content.trim())
    .map(normalizeStep);
  if (steps.length === 0) return "[参数错误] update_plan：没有有效的步骤。";

  // 同一时刻只应有一个进行中的步骤：多了说明模型没有真正在"逐步推进"，提示但不拒绝
  const doing = steps.filter((x: PlanStep) => x.status === "in_progress").length;

  if (typeof args.goal === "string" && args.goal.trim()) s.goal = args.goal.trim().slice(0, MAX_GOAL_CHARS);
  s.steps = steps;

  const done = steps.filter((x: PlanStep) => x.status === "done").length;
  const warn = doing > 1 ? "\n[提示] 同一时刻建议只有一个 in_progress 步骤。" : "";
  return `计划已更新（${done}/${steps.length} 完成）：\n${renderPlan(s)}${warn}`;
}

export function saveNotes(s: TaskState, args: any): string {
  const content = typeof args?.content === "string" ? args.content.trim() : "";
  if (content.length > MAX_NOTES_CHARS) {
    return `[参数错误] save_notes：笔记 ${content.length} 字符，超过上限 ${MAX_NOTES_CHARS}。请只保留对后续步骤仍有用的结论后重试。`;
  }
  s.notes = content;
  return content ? `笔记已保存（${content.length} 字符）。` : "笔记已清空。";
}
