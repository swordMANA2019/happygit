import { execSync } from "node:child_process";
import { ROOT } from "./config.js";
import { listFiles } from "./tools/fs.js";

export async function buildContext() {
  const tree = await listFiles(".", 3);

  let git = "";
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: ROOT,
      timeout: 3000,
    }).toString().trim();

    const status = execSync("git status --short", {
      cwd: ROOT,
      timeout: 3000,
    }).toString().trim();

    git = `分支：${branch}\n变更：\n${status || "（无）"}`;
  } catch {
    git = "";
  }

  const parts = [`工作目录：${ROOT}`, `项目结构：\n${tree}`];
  if (git) {
    parts.push(`Git：\n${git}`);
  }

  return parts.join("\n\n");
}