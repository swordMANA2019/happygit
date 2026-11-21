import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 应用图标：窗口标题栏 / 任务栏 / 侧边栏用的那张图。
 *
 * 默认是内置的 icon.svg。想换成自己的图，把一张图片命名为 icon.png（也支持 .svg .ico .jpg .jpeg .webp）放到下面任意位置，
 * 重启即可（优先级从高到低）：
 *   1. 环境变量 AGENT_UI_ICON 指向的文件
 *   2. 可执行文件（mini-agent.exe）所在目录
 *   3. 用户数据目录 ~/.mini-agent/（AGENT_UI_DATA 可改）
 */

export const ICON_TYPES: Record<string, string> = {
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const NAMES = ["icon.png", "icon.svg", "icon.ico", "icon.jpg", "icon.jpeg", "icon.webp"];

export type CustomIcon = { file: string; type: string };

function usable(file: string): CustomIcon | null {
  const type = ICON_TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;
  try {
    const st = fs.statSync(file);
    if (st.isFile() && st.size > 0 && st.size <= MAX_ICON_BYTES) return { file, type };
  } catch { /* 不存在 */ }
  return null;
}

/** 数据目录：AGENT_UI_DATA > ~/.mini-agent。null = 不使用（测试） */
export function defaultDataDir(): string {
  return process.env.AGENT_UI_DATA || path.join(os.homedir(), ".mini-agent");
}

/** 找用户自带的图标；没有返回 null（调用方回退到内置图标）。每次请求都查：换图后刷新窗口就生效 */
export function findCustomIcon(dataDir: string | null, env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): CustomIcon | null {
  if (env.AGENT_UI_ICON) {
    const hit = usable(path.resolve(env.AGENT_UI_ICON));
    if (hit) return hit;
  }
  const dirs: string[] = [];
  // 开发时 execPath 是 node/bun 本身，那个目录不是"应用目录"
  if (!/^(node|bun)(\.exe)?$/i.test(path.basename(execPath))) dirs.push(path.dirname(execPath));
  if (dataDir) dirs.push(dataDir);
  for (const d of dirs) for (const n of NAMES) {
    const hit = usable(path.join(d, n));
    if (hit) return hit;
  }
  return null;
}
