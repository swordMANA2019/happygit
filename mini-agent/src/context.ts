import fs from "node:fs/promises";
import path from "node:path";
import { ensureManifest } from "./probe.js";
import { gitInfo } from "./workspace.js";

/** 项目级规则文件（对应 Cursor 的 rules / AGENTS.md），按优先级取第一个存在的 */
const RULE_FILES = ["AGENTS.md", ".cursorrules", "CLAUDE.md", ".agent/rules.md"];
const RULES_CAP = 4000;

async function loadRules(root: string): Promise<string> {
  for (const f of RULE_FILES) {
    try {
      const text = (await fs.readFile(path.join(root, f), "utf-8")).trim();
      if (text) return `\n## 项目规则（${f}）\n${text.slice(0, RULES_CAP)}${text.length > RULES_CAP ? "\n…（已截断）" : ""}\n`;
    } catch { /* 不存在，试下一个 */ }
  }
  return "";
}

async function envBlock(root: string): Promise<string> {
  const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh");
  const g = await gitInfo(root);
  const gitLine =
    g.state === "repo"        ? `git：可用，分支 ${g.branch}，${g.dirty.length} 个未提交改动（仅供参考；不要用 git 改写仓库状态）` :
    g.state === "not_repo"    ? "git：已安装，但项目目录不是 git 仓库" :
                                `git：不可用（${g.detail}）。不要依赖任何 git 命令`;
  return [
    "## 运行环境",
    `- 系统：${process.platform}/${process.arch}  Node ${process.version}`,
    `- shell：${shell}${process.platform === "win32" ? "（Windows：没有 ls/cat/grep，优先使用 list_files/read_file/search_code 工具）" : ""}`,
    `- 项目根：${root}`,
    `- ${gitLine}`,
  ].join("\n");
}

export async function buildContext(root: string, model?: string): Promise<string> {
  const m = await ensureManifest(root, model);

  const rejected = m.rejected?.length
    ? `\n已排除的不可用验证命令：${m.rejected.map((r) => `${r.cmd}（${r.reason}）`).join("；")}`
    : "";

  const verifierBlock = m.verifyCommands.length
    ? [
        "## 本项目验证环境",
        `语言：${m.lang}`,
        "可用验证命令（按优先级，exit 0 = 通过）：",
        ...m.verifyCommands.map((c, i) => `${i + 1}. ${c}`),
        "规则：每次修改代码后，必须用 run_command 执行上述命令之一，并把原始输出作为下一步输入。" + rejected,
      ].join("\n")
    : [
        "## 本项目验证环境",
        `语言：${m.lang}（未发现可用验证命令）${rejected}`,
        "请先用 list_files / search_code 找出测试脚本或构建配置，确定验证方法后再修改代码；",
        "如果确实无法验证，请在最终总结里明确写出“未验证”及原因。",
      ].join("\n");

  const rubricBlock = m.rubric ? `\n## 验收清单\n${m.rubric}\n` : "";
  const rules = await loadRules(root);

  return `${await envBlock(root)}\n\n${verifierBlock}${rubricBlock}${rules}`;
}
