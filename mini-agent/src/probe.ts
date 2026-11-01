import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { client } from "./llm.js";
import { ROOT, MANIFEST_TTL_MS } from "./config.js";

const execAsync = promisify(exec);

const RULES = [
  { lang: "rust",       markers: ["Cargo.toml"],                          cmds: ["cargo check", "cargo test"] },
  { lang: "go",         markers: ["go.mod"],                              cmds: ["go build ./...", "go test ./..."] },
  { lang: "java",       markers: ["pom.xml", "build.gradle", "gradlew"],  cmds: ["mvn compile -q", "./gradlew compileJava"] },
  { lang: "python",     markers: ["pyproject.toml", "setup.py", "requirements.txt"], cmds: ["pytest -q", "python -m compileall -q ."] },
  { lang: "typescript", markers: ["tsconfig.json"],                       cmds: ["npx tsc --noEmit", "npm test", "npx eslint . --max-warnings=0"] },
  { lang: "javascript", markers: ["package.json"],                        cmds: ["npm test", "npm run lint"] },
  { lang: "ruby",       markers: ["Gemfile"],                             cmds: ["bundle exec rake", "bundle exec rspec"] },
  { lang: "php",        markers: ["composer.json"],                       cmds: ["vendor/bin/phpstan analyse", "composer test"] },
];

const BUILD_FILES = ["package.json", "Cargo.toml", "pyproject.toml", "pom.xml", "go.mod", "build.gradle", "tsconfig.json"];

export type Manifest = {
  lang: string;
  verifyCommands: string[];
  rubric?: string;
  probedAt: number;
  mtimes: Record<string, number>;   // 构建文件的修改时间，用于失效判断
};

const MANIFEST_PATH = ".agent/manifest.json";

async function pickLang(root: string): Promise<string> {
  const files = new Set(await fs.readdir(root));
  let best = "unknown", score = 0;
  for (const r of RULES) {
    const n = r.markers.filter((m) => files.has(m)).length;
    if (n > score) { score = n; best = r.lang; }
  }
  return best;
}

async function smoke(root: string, cmd: string): Promise<boolean> {
  try {
    await execAsync(cmd, { cwd: root, timeout: 25_000, maxBuffer: 20 * 1024 * 1024 });
    return true;
  } catch (e: any) {
    const t = (e.stderr ?? e.stdout ?? String(e)).toLowerCase();
    // 退出码非 0 但命令存在 = 它在干活，是好验证器；只有"找不到命令/超时"算不可用
    return !(t.includes("not found") || t.includes("command not found")

      || t.includes("no such file") || e.code === "ENOENT" || e.code === "ETIMEDOUT" || e.killed);
  }
}

async function getMtimes(root: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const f of BUILD_FILES) {
    try { const s = await fs.stat(path.join(root, f)); out[f] = s.mtimeMs; } catch {}
  }
  return out;
}

function mtimesChanged(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { if (a[k] !== b[k]) return true; }
  return false;
}

async function buildRubric(root: string, lang: string): Promise<string> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const tree = entries.slice(0, 60).filter((e) => !e.name.startsWith(".")).map((e) => e.isDirectory() ? `${e.name}/` : e.name).join("\n");
    const prompt = `你是 QA。根据项目材料生成"可判定的验收清单"，每条必须能被 shell 命令或人工一眼判定。
语言：${lang}
文件树：
${tree}
输出纯 JSON 数组：[{"text":"...","command":"..."}]，不要有其他文字。至少包含一条编译/类型检查、一条测试、一条产物存在性检查。`;
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0,
    });
    const arr = JSON.parse(resp.choices[0].message.content ?? "[]") as any[];
    if (!Array.isArray(arr)) return "";
    return arr.map((x) => `- [ ] ${String(x.text)}  →  \`${x.command}\``).join("\n");
  } catch {
    return "";
  }
}

export async function loadManifest(root = ROOT): Promise<Manifest | null> {
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

export async function ensureManifest(root = ROOT): Promise<Manifest> {
  const cached = await loadManifest(root);
  if (cached) return cached;

  const lang = await pickLang(root);
  const rule = RULES.find((r) => r.lang === lang);
  const cmds = rule
    ? (await Promise.all(rule.cmds.map(async (c) => ({ c, ok: await smoke(root, c) }))))
        .filter((x) => x.ok).map((x) => x.c)
    : [];

  const rubric = cmds.length ? await buildRubric(root, lang) : "";
  const mtimes = await getMtimes(root);
  const m: Manifest = { lang, verifyCommands: cmds, rubric, probedAt: Date.now(), mtimes };

  await fs.mkdir(path.join(root, ".agent"), { recursive: true });
  await fs.writeFile(path.join(root, MANIFEST_PATH), JSON.stringify(m, null, 2));
  console.error(`[probe] lang=${lang} verifiers=[${cmds.join(", ") || "none"}]`);
  return m;
}

export async function invalidateManifest(root = ROOT): Promise<void> {
  try { await fs.unlink(path.join(root, MANIFEST_PATH)); } catch {}
}