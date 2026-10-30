import { exec } from "node:child_process";

const ALLOW = new Set([
  "ls", "cat", "grep", "rg", "find", "wc", "head", "tail", "pwd", "echo",
  "git", "node", "npm", "pnpm", "yarn", "tsc", "python", "pytest",
  "cargo", "go", "make",
]);

export function runCommand(command: string, timeoutMs = 60_000) {
  const bin = command.trim().split(/\s+/)[0];
  if (!ALLOW.has(bin)) {
    return Promise.resolve(`命令被拒绝：${bin} 不在白名单内`);
  }
  return new Promise<string>((resolve) => {
    exec(command, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join("\n").slice(0, 8000);
      resolve(err ? `退出码异常：\n${out}` : out || "（无输出）");
    });
  });
}