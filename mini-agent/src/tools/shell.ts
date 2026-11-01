import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function runCommand(
  command: string,
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const timeout = opts.timeoutMs ?? 60_000;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return (stdout + stderr).trim() || "(命令执行成功，无输出)";
  } catch (e: any) {
    const out = (e.stdout ?? "") + (e.stderr ?? "") + String(e);
    return out.trim() || `命令失败：${e.message}`;
  }
}