import { ensureManifest } from "./probe.js";

export async function buildContext(root = process.cwd()): Promise<string> {
  const m = await ensureManifest(root);

  const verifierBlock = m.verifyCommands.length
    ? [
        "## 本项目验证环境",
        `语言：${m.lang}`,
        "可用验证命令（按优先级，exit 0 = 通过）：",
        ...m.verifyCommands.map((c, i) => `${i + 1}. ${c}`),
        "规则：每次修改代码后，必须用 run_command 执行上述命令之一，并把原始输出作为下一步输入。",
      ].join("\n")
    : [
        "## 本项目验证环境",
        `语言：${m.lang}（未发现可用验证命令）`,
        "请先用 list_files / search_code 找出测试脚本或构建配置，确定验证方法后再修改代码。",
      ].join("\n");

  const rubricBlock = m.rubric ? `\n## 验收清单\n${m.rubric}\n` : "";

  // 这里接你原有的文件树 / 打开文件 / 最近编辑等上下文
  return `${verifierBlock}${rubricBlock}`;
}