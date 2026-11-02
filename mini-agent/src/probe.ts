import fs from "node:fs/promises";
import path from "node:path";
import { client } from "./llm.js";
import { MODEL, MANIFEST_TTL_MS } from "./config.js";
import { execCommand } from "./tools/shell.js";

// npx 一律加 --no-install：本地没装就应判定"不可用"，而不是在探测阶段去联网下载
const RULES = [
  { lang: "rust",       markers: ["Cargo.toml"],                          cmds: ["cargo check", "cargo test"] },
  { lang: "go",         markers: ["go.mod"],                              cmds: ["go build ./...", "go test ./..."] },
  { lang: "java",       markers: ["pom.xml", "build.gradle", "gradlew"],  cmds: ["mvn compile -q", "./gradlew compileJava"] },
  { lang: "python",     markers: ["pyproject.toml", "setup.py", "requirements.txt"], cmds: ["pytest -q", "python -m compileall -q ."] },
  { lang: "typescript", markers: ["tsconfig.json"],                       cmds: ["npx --no-install tsc --noEmit", "npm test", "npx --no-install eslint . --max-warnings=0"] },
  { lang: "javascript", markers: ["package.json"],                        cmds: ["npm test", "npm run lint"] },
  { lang: "ruby",       markers: ["Gemfile"],                             cmds: ["bundle exec rake", "bundle exec rspec"] },
  { lang: "php",        markers: ["composer.json"],                       cmds: ["vendor/bin/phpstan analyse", "composer test"] },
];

const BUILD_FILES = ["package.json", "Cargo.toml", "pyproject.toml", "pom.xml", "go.mod", "build.gradle", "tsconfig.json"];

export type Manifest = {
  lang: string;
  verifyCommands: string[];
  /** 探测时被判定不可用的命令及原因（供提示用户："为什么没有验证器"） */
  rejected?: Array<{ cmd: string; reason: string }>;
  rubric?: string;
  probedAt: number;
  mtimes: Record<string, number>;   // 构建文件的修改时间，用于失效判断
};

const MANIFEST_PATH = ".agent/manifest.json";

async function pickLang(root: string): Promise<string> {
  let files: Set<string>;
  try {
    files = new Set(await fs.readdir(root));
  } catch {
    return "unknown";
  }
  let best = "unknown", score = 0;
  for (const r of RULES) {
    const n = r.markers.filter((m) => files.has(m)).length;
    if (n > score) { score = n; best = r.lang; }
  }
  return best;
}

/**
 * 验证器可用性探测。
 * 判定依据是结构化的失败分类（退出码 + 多语言输出模式），而不是只匹配英文 "not found"：
 *   旧实现在 Windows 上看到 "'tsc' 不是内部或外部命令" 会误判为"命令存在、正在干活"，
 *   于是把一个根本跑不起来的验证器记进 manifest，之后每一轮重试都在这个坏验证器上空转。
 */
async function smoke(root: string, cmd: string): Promise<{ ok: boolean; reason: string }> {
  const r = await execCommand(cmd, { cwd: root, timeoutMs: 25_000 });
  if (r.ok) return { ok: true, reason: "" };
  // 退出码非 0 但属于"代码层失败" = 命令确实在工作，是好验证器
  if (r.kind === "code") return { ok: true, reason: "" };
  return { ok: false, reason: r.reason };
}

async function getMtimes(root: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const f of BUILD_FILES) {
    try { const s = await fs.stat(path.join(root, f)); out[f] = s.mtimeMs; } catch { /* 不存在 */ }
  }
  return out;
}

function mtimesChanged(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { if (a[k] !== b[k]) return true; }
  return false;
}

function parseJsonArray(raw: string): any[] {
  // 很多模型即使要求"纯 JSON"也会包 ```json 围栏
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const v = JSON.parse(t);
  return Array.isArray(v) ? v : [];
}

async function buildRubric(root: string, lang: string, model: string): Promise<string> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const tree = entries.slice(0, 60).filter((e) => !e.name.startsWith(".")).map((e) => e.isDirectory() ? `${e.name}/` : e.name).join("\n");
    const prompt = `你是 QA。根据项目材料生成"可判定的验收清单"，每条必须能被 shell 命令或人工一眼判定。
语言：${lang}
文件树：
${tree}
输出纯 JSON 数组：[{"text":"...","command":"..."}]，不要有其他文字。至少包含一条编译/类型检查、一条测试、一条产物存在性检查。`;
    const resp = await client.chat.completions.create({
      model, messages: [{ role: "user", content: prompt }], temperature: 0,
    }, { timeout: 30_000 });
    const arr = parseJsonArray(resp.choices[0].message.content ?? "[]");
    return arr.map((x) => `- [ ] ${String(x.text)}  →  \`${x.command}\``).join("\n");
  } catch {
    return ""; // rubric 只是锦上添花，LLM 不可用时不影响主流程
  }
}

export async function loadManifest(root: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(path.join(root, MANIFEST_PATH), "utf-8");
    const m = JSON.parse(raw) as Manifest;
    if (Date.now() - m.probedAt > MANIFEST_TTL_MS) return null;
    if (mtimesChanged(m.mtimes, await getMtimes(root))) return null; // 构建配置变了就重探
    return m;
  } catch {
    return null;
  }
}

export async function ensureManifest(root: string, model = MODEL): Promise<Manifest> {
  const cached = await loadManifest(root);
  if (cached) return cached;

  const lang = await pickLang(root);
  const rule = RULES.find((r) => r.lang === lang);
  const probed = rule
    ? await Promise.all(rule.cmds.map(async (cmd) => ({ cmd, ...(await smoke(root, cmd)) })))
    : [];
  const cmds = probed.filter((x) => x.ok).map((x) => x.cmd);
  const rejected = probed.filter((x) => !x.ok).map((x) => ({ cmd: x.cmd, reason: x.reason }));

  const rubric = cmds.length ? await buildRubric(root, lang, model) : "";
  const mtimes = await getMtimes(root);
  const m: Manifest = { lang, verifyCommands: cmds, rejected, rubric, probedAt: Date.now(), mtimes };

  // 只读目录/磁盘满等情况下写不了缓存：不影响本次使用
  try {
    await fs.mkdir(path.join(root, ".agent"), { recursive: true });
    await fs.writeFile(path.join(root, MANIFEST_PATH), JSON.stringify(m, null, 2));
  } catch (e: any) {
    console.error(`[probe] 无法写入缓存（${e.code ?? e.message}），本次结果不缓存`);
  }
  console.error(`[probe] lang=${lang} verifiers=[${cmds.join(", ") || "none"}]` +
    (rejected.length ? ` rejected=[${rejected.map((r) => `${r.cmd}(${r.reason})`).join(", ")}]` : ""));
  return m;
}

export async function invalidateManifest(root: string): Promise<void> {
  try { await fs.unlink(path.join(root, MANIFEST_PATH)); } catch { /* 本来就没有 */ }
}
