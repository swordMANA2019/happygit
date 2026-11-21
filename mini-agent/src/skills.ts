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

/**
 * 解析 SKILL.md 的 frontmatter。容忍：开头的空行/BOM、CRLF、带引号的值，
 * 以及 YAML 的多行写法（description: > 或 | 后面缩进的若干行，或直接缩进续行）——合成一行。
 */
function parse(text: string): { meta: Record<string, string>; body: string } {
  const m = text.replace(/^\uFEFF/, "").match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    const parts: string[] = [];
    // 值写在后面缩进的行里（块标量 > | 或空值），或普通值的缩进续行
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || (lines[i + 1].trim() === "" && /^[ \t]+\S/.test(lines[i + 2] ?? "")))) {
      const next = lines[++i].trim();
      if (next) parts.push(next);
    }
    if (/^[>|][+-]?$/.test(val)) val = parts.join(" ");
    else if (parts.length) val = [val, ...parts].filter(Boolean).join(" ");
    meta[kv[1]] = val.replace(/^(['"])(.*)\1$/, "$2");
  }
  return { meta, body: m[2] };
}

/** 被跳过的候选目录及原因：/skills 会告诉用户，而不是悄悄忽略 */
export type SkippedSkill = { dir: string; source: Skill["source"]; reason: string };

async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }   // stat 会跟随符号链接/junction
}

/** 找到目录里的 SKILL.md（不区分大小写：Linux 上 skill.md 也能用） */
async function findSkillFile(dir: string): Promise<string | null> {
  const exact = path.join(dir, "SKILL.md");
  try { await fs.access(exact); return exact; } catch { /* 再试不区分大小写 */ }
  try {
    const hit = (await fs.readdir(dir)).find((n) => n.toLowerCase() === "skill.md");
    return hit ? path.join(dir, hit) : null;
  } catch { return null; }
}

async function scanDir(dir: string, source: Skill["source"], skipped?: SkippedSkill[]): Promise<Skill[]> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: Skill[] = [];
  for (const e of entries) {
    const skillDir = path.join(dir, e.name);
    // 符号链接 / junction 指向的目录同样算（常见做法：把共享技能链接进项目）
    if (!(e.isDirectory() || (e.isSymbolicLink() && (await isDir(skillDir))))) continue;
    const skip = (reason: string) => { skipped?.push({ dir: skillDir, source, reason }); };
    try {
      const file = await findSkillFile(skillDir);
      if (!file) {
        let inner = "";
        try {
          for (const sub of await fs.readdir(skillDir, { withFileTypes: true })) {
            if ((sub.isDirectory() || sub.isSymbolicLink()) && (await findSkillFile(path.join(skillDir, sub.name)))) { inner = sub.name; break; }
          }
        } catch { /* 忽略 */ }
        skip(inner
          ? `里面的 ${inner}/ 才有 SKILL.md——技能目录只支持一层（<技能目录>/<名字>/SKILL.md），请把 ${inner}/ 移到上一层`
          : "没有 SKILL.md（每个技能必须是 <名字>/SKILL.md）");
        continue;
      }
      const { meta, body } = parse(await fs.readFile(file, "utf-8"));
      const name = (meta.name || e.name).trim();
      if (!meta.description) { skip("SKILL.md 缺少 description（开头要有 --- 包起来的 frontmatter，并写 description: 一句话说明什么任务该用它）"); continue; }
      out.push({
        name, description: meta.description, dir: skillDir, body, source,
        verify: meta.verify || undefined,
        verifyExt: (meta.verify_ext ?? "").split(/[,\s]+/).filter(Boolean).map((x) => x.toLowerCase()),
      });
    } catch (err: any) { skip(`读取失败：${err?.code ?? err?.message ?? err}`); }
  }
  return out;
}

/** 技能搜索的目录（按优先级从低到高） */
export function skillDirs(root: string): Array<{ dir: string; source: Skill["source"] }> {
  return [
    { dir: BUILTIN_DIR, source: "builtin" },
    { dir: path.join(os.homedir(), ".mini-agent", "skills"), source: "user" },
    { dir: path.join(root, ".agent", "skills"), source: "project" },
    { dir: path.join(root, ".cursor", "skills"), source: "project" },
  ];
}

export async function discoverSkills(root: string, skipped?: SkippedSkill[]): Promise<Skill[]> {
  const layers = await Promise.all(skillDirs(root).map((l) => scanDir(l.dir, l.source, skipped)));
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

/** 模型传来的技能名不必一字不差：忽略大小写与 - _ 空格，也认文件夹名（image_gen / Image-Gen / 文件夹名 都能找到 image-gen） */
export function findSkill(skills: Skill[], name: unknown): Skill | undefined {
  const n = String(name ?? "").trim();
  if (!n) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, "");
  return skills.find((s) => s.name === n)
    ?? skills.find((s) => norm(s.name) === norm(n) || norm(path.basename(s.dir)) === norm(n));
}

/** use_skill 的返回：正文（占位符已替换成真实路径/解释器）+ 技能目录里的文件清单 */
export async function loadSkillText(skills: Skill[], name: unknown): Promise<{ text: string; skill?: Skill }> {
  const skill = findSkill(skills, name);
  if (!skill) {
    // 列出名字+用途：模型看到"用途"才能把用户的说法（如"生成图片"）对应到某个技能，而不是直接放弃
    return { text: `[工具错误] 没有名为 ${String(name)} 的技能。可用技能（名称：用途）：\n${skills.map((s) => `- ${s.name}：${s.description}`).join("\n") || "无"}\n请从上面选一个最匹配的名称重新调用 use_skill；确实都不匹配再如实告诉用户。` };
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
