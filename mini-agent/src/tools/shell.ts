import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolveCwd } from "../guard.js";

const execAsync = promisify(exec);
const isWin = process.platform === "win32";

export async function runCommand(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; root?: string } = {}
): Promise<string> {
  const root = opts.root ?? process.cwd();
  let cwd: string;
  try {
    cwd = resolveCwd(root, opts.cwd);
  } catch (e: any) {
    return e.message;
  }
  const timeout = opts.timeoutMs ?? 90_000;
  const shell = isWin ? "cmd.exe" : undefined;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      shell,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return (stdout + stderr).trim() || "(执行成功，无输出)";
  } catch (e: any) {
    return ((e.stdout ?? "") + (e.stderr ?? "") + String(e)).trim() || `命令失败：${e.message}`;
  }
}

export { execAsync as execAsyncPromised };