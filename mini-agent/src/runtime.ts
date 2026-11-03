import { execCommand } from "./tools/shell.js";

/**
 * 运行时探测：技能脚本（python-pptx、RDKit…）需要 Python。
 * 结果是机器事实，进程内缓存一次即可。
 */
export type PythonInfo = { cmd: string; version: string } | null;

let cached: Promise<PythonInfo> | null = null;

export function detectPython(): Promise<PythonInfo> {
  cached ??= (async () => {
    for (const cmd of ["python", "python3", "py -3"]) {
      const r = await execCommand(`${cmd} --version`, { timeoutMs: 8000 });
      const m = `${r.stdout}${r.stderr}`.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/i);
      if (r.ok && m) return { cmd, version: m[1] };
    }
    return null;
  })();
  return cached;
}
