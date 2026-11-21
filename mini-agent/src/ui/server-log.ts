import fs from "node:fs";
import path from "node:path";
import { formatTrace, type TraceEvent } from "../trace.js";

/**
 * 界面模式下的后端日志：所有 console.* 和 ReAct 轨迹都追加到本地文件，供开发者排查。
 * 默认 ~/.mini-agent/logs/（AGENT_UI_DATA 可改）；测试时可传 null 关闭写入。
 */
export type ServerLog = {
  backend(chatId: string, stream: "out" | "err", text: string): void;
  react(chatId: string, ev: TraceEvent): void;
};

export function openServerLog(dataDir: string | null): ServerLog {
  if (!dataDir) return { backend: () => {}, react: () => {} };
  const dir = path.join(dataDir, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 只影响落盘 */ }

  const append = (file: string, line: string) => {
    try { fs.appendFileSync(path.join(dir, file), line, "utf8"); } catch { /* 盘满等不应拖垮服务 */ }
  };

  return {
    backend(chatId, stream, text) {
      const stamp = new Date().toISOString();
      for (const chunk of text.split(/\n/)) {
        if (!chunk) continue;
        append(`backend-${chatId}.log`, `${stamp} [${stream}] ${chunk}\n`);
      }
    },
    react(chatId, ev) {
      append(`react-${chatId}.log`, `${new Date().toISOString()} ${formatTrace(ev).replace(/^\n/, "")}\n`);
    },
  };
}