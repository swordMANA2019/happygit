import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectPython } from "./runtime.js";

/**
 * 技能（Skills）：可按需加载的"任务手册"。
 *
 * 每个技能是一个目录：  <name>/SKILL.md  (+ scripts/ templates/ 等任意文件)
 * SKILL.md 以 frontmatter 开头：
 *   ---
 *   name: pptx
 *   description: 一句话说明"什么任务该用我"（模型只看到这一句，用来决定要不要加载）
 *   verify: {python} "{skill_dir}/scripts/check_deck.py" {changed}     # 可选：完成后的自动验证命令
 *   verify_ext: .pptx                                                  # 可选：只验证这些扩展名的产出文件
 *   ---
 *   （正文：步骤、脚本用法、注意事项、如何自检）
 *
 * 渐进式披露：系统提示里只放 name + description（很便宜，装几十个也没关系）；
 * 模型判断任务相关时调用 use_skill 才读到正文。领域知识放进技能和脚本，而不是写进 Agent 核心代码。
 *
 * 查找顺序（后者同名覆盖前者）：内置 skills/ → ~/.mini-agent/skills → <项目>/.agent/skills → <项目>/.cursor/skills
 */

export type Skill = {
  name: string;
  description: string;
  dir: string;
  body: string;
  verify?: string;
  verifyExt: string[];
  source: "builtin" | "user" | "project";
};

const BUILTIN_DIR = fileURLToPath(new URL("../skills", import.meta.url));

function parse(text: string): { meta: Record<string, string>; body: string } {
  const m = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return { meta, body: m[2] };
}

async function scanDir(dir: string, source: Skill["source"]): Promise<Skill[]> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillDir = path.join(dir, e.name);
    try {
      const { meta, body } = parse(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8"));
      const name = (meta.name || e.name).trim();
      if (!meta.description) continue;           // 没有描述的技能模型无从判断何时使用
      out.push({
        name, description: meta.description, dir: skillDir, body, source,
        verify: meta.verify || undefined,
        verifyExt: (meta.verify_ext ?? "").split(/[,\s]+/).filter(Boolean).map((x) => x.toLowerCase()),
      });
    } catch { /* 没有 SKILL.md 或读不了：跳过 */ }
  }
  return out;
}

export async function discoverSkills(root: string): Promise<Skill[]> {
  const layers = await Promise.all([
    scanDir(BUILTIN_DIR, "builtin"),
    scanDir(path.join(os.homedir(), ".mini-agent", "skills"), "user"),
    scanDir(path.join(root, ".agent", "skills"), "project"),
    scanDir(path.join(root, ".cursor", "skills"), "project"),
  ]);
  const byName = new Map<string, Skill>();
  for (const s of layers.flat()) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 系统提示里的技能清单（只有名字和一句话） */
export function skillsBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return [
    "## 可用技能（Skills）",
    "技能是针对某类任务的详细手册（步骤、现成脚本、验证方法）。当用户的任务匹配某个技能时，**先调用 use_skill(name) 读取手册再动手**；不匹配就不要加载。",
    ...skills.map((s) => `- ${s.name}：${s.description}`),
  ].join("\n");
}

async function listFiles(dir: string, base = dir, depth = 0, acc: string[] = []): Promise<string[]> {
  if (depth > 2 || acc.length >= 40) return acc;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === "SKILL.md" || e.name === "__pycache__") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, base, depth + 1, acc);
    else acc.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return acc;
}

/** use_skill 的返回：正文（占位符已替换成真实路径/解释器）+ 技能目录里的文件清单 */
export async function loadSkillText(skills: Skill[], name: unknown): Promise<{ text: string; skill?: Skill }> {
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    return { text: `[工具错误] 没有名为 ${String(name)} 的技能。可用技能：${skills.map((s) => s.name).join(", ") || "无"}` };
  }
  const py = await detectPython();
  const pyCmd = py?.cmd ?? "python";
  const body = skill.body.replace(/\{skill_dir\}/g, skill.dir).replace(/\{python\}/g, pyCmd);
  const files = await listFiles(skill.dir);
  const env = py ? `（已检测到 Python ${py.version}，命令：${py.cmd}）` : "（⚠ 未检测到 Python：需要 Python 的步骤无法执行，请如实告知用户）";
  return {
    skill,
    text: `# 技能：${skill.name}\n技能目录：${skill.dir}\n${env}\n${files.length ? `目录内文件：\n${files.map((f) => `  - ${f}`).join("\n")}\n` : ""}\n${body}`,
  };
}

/** 本次任务中用过的技能所声明的验证命令（针对实际产出的文件） */
export async function skillVerifiers(skills: Skill[], used: Set<string>, producedFiles: string[]): Promise<string[]> {
  const py = await detectPython();
  const cmds: string[] = [];
  for (const s of skills) {
    if (!used.has(s.name) || !s.verify) continue;
    const files = producedFiles.filter((f) => s.verifyExt.length === 0 || s.verifyExt.includes(path.extname(f).toLowerCase()));
    if (files.length === 0) continue;
    if (s.verify.includes("{python}") && !py) continue;
    cmds.push(
      s.verify
        .replace(/\{skill_dir\}/g, s.dir)
        .replace(/\{python\}/g, py?.cmd ?? "python")
        .replace(/\{changed\}/g, files.map((f) => `"${f}"`).join(" ")),
    );
  }
  return cmds;
}
