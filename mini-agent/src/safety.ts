import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ROOT } from "./config.js";

const SAFE_CACHE = new Set<string>();

export async function insideRoot(p: string): Promise<string> {
  const abs = path.resolve(ROOT, p);

  // 仍在项目根目录内，直接放行
  if (abs === ROOT || abs.startsWith(ROOT + path.sep)) {
    return abs;
  }

  // 之前已经确认过的路径，不再重复询问
  if (SAFE_CACHE.has(abs)) {
    return abs;
  }

  // 越界路径，需要用户确认
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `\n⚠️  路径越界：${p}\n解析为：${abs}\n不在项目根目录 ${ROOT} 内，是否允许访问？(yes/no) `
  );
  rl.close();

  if (answer.trim().toLowerCase() === "yes") {
    SAFE_CACHE.add(abs);
    return abs;
  }

  throw new Error(`用户拒绝访问：${p}`);
}