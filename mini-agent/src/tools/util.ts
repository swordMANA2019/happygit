import {CONTEXT_CHAR_BUDGET, EARLY_FOLD_RATIO} from "../config.js"
import {msgSize} from "../util.js"
import type { ToolCtx } from "./context.js";
import type { Msg } from "../util.js";

// ============================================================================
// 1. STATE TYPES & HELPERS (Attach `fileMemories` to your ToolCtx or session)
// ============================================================================

export type LineRange = [number, number]; // [startLine, endLine] (1-indexed, inclusive)

export interface FileMemory {
  relPath: string;
  totalLines: number;
  mtimeMs: number; // Used to detect if the file changed on disk since last read
  readRanges: LineRange[];
  outline: Map<number, string>; // lineNum -> structural signature
}

// Add `fileMemories?: Map<string, FileMemory>` to your `ToolCtx` interface,
// or keep a fallback WeakMap<object, Map<string, FileMemory>> keyed by `ctx`.
const ctxMemoryFallback = new WeakMap<object, Map<string, FileMemory>>();

export function getFileMemories(ctx: ToolCtx): Map<string, FileMemory> {
  if ((ctx as any).fileMemories) return (ctx as any).fileMemories;
  let map = ctxMemoryFallback.get(ctx);
  if (!map) {
    map = new Map();
    ctxMemoryFallback.set(ctx, map);
  }
  return map;
}

export function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: LineRange[] = [[...sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const [curStart, curEnd] = sorted[i];
    const last = merged[merged.length - 1];
    if (curStart <= last[1] + 1) {
      last[1] = Math.max(last[1], curEnd);
    } else {
      merged.push([curStart, curEnd]);
    }
  }
  return merged;
}

/** Deterministic, zero-token structural extractor for code, HTML, CSS, logs, JSON/YAML */
export function extractStructure(relPath: string, lines: string[], startLine: number, outline: Map<number, string>) {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";

  lines.forEach((rawLine, idx) => {
    const lineNum = startLine + idx;
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    if (["ts", "tsx", "js", "jsx", "py", "go", "java", "rs", "cpp", "c"].includes(ext)) {
      if (/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|struct|def|func|fn)\s+\w+/.test(trimmed)) {
        outline.set(lineNum, `L${lineNum}: ${trimmed.slice(0, 80)}`);
      }
    } else if (["html", "vue", "svelte"].includes(ext)) {
      if (/<(header|nav|main|section|article|form|footer|table|script|template)\b|id=["'][^"']+["']/.test(trimmed)) {
        outline.set(lineNum, `L${lineNum}: ${trimmed.slice(0, 80)}`);
      }
    } else if (["css", "scss", "less"].includes(ext)) {
      if (/^(@media|@keyframes|:root|[.#a-zA-Z][\w\s,>~+.-]*\{)/.test(trimmed)) {
        outline.set(lineNum, `L${lineNum}: ${trimmed.slice(0, 80)}`);
      }
    } else if (ext === "log" || ext === "txt") {
      if (/\b(ERROR|FATAL|WARN|Exception|Traceback|Failed)\b/i.test(trimmed)) {
        outline.set(lineNum, `L${lineNum}: ${trimmed.slice(0, 100)}`);
      }
    } else if (["json", "yaml", "yml", "toml"].includes(ext)) {
      // Top-level or shallow keys (indentation <= 2 spaces)
      if (/^(\s{0,2}["']?[\w.-]+["']?\s*:|\[[\w.-]+\])/.test(rawLine)) {
        outline.set(lineNum, `L${lineNum}: ${trimmed.slice(0, 80)}`);
      }
    }
  });
}

function buildContextReceipt(mem: FileMemory): string {
  const rows: string[] = [];
  let cursor = 1;

  for (const [start, end] of mem.readRanges) {
    if (start > cursor) {
      rows.push(`  L${cursor}-L${start - 1}: [未读取 / UNREAD，共 ${start - cursor} 行]`);
    }
    rows.push(`  L${start}-L${end}: [已读取 / READ]`);
    let foundSymbol = false;
    for (let l = start; l <= end; l++) {
      const sym = mem.outline.get(l);
      if (sym) {
        rows.push(`    ${sym}`);
        foundSymbol = true;
      }
    }
    if (!foundSymbol) {
      rows.push(`  (此区间无顶层声明/关键错误，具体细节应已存入 save_notes）`);
    }
    cursor = end + 1;
  }

  if (cursor <= mem.totalLines) {
    rows.push(`  L${cursor}-L${mem.totalLines}: [未读取 / UNREAD，共 ${mem.totalLines - cursor + 1} 行]`);
  }

  return [
    `[文件上下文回执 | 路径: ${mem.relPath} | 总行数: ${mem.totalLines}]`,
    `阅读覆盖与结构索引：`,
    ...rows,
    `提示：禁止重复读取 [已读取] 区间（除非文件已被修改或正在编辑该行）；如需后续内容请仅针对 [未读取] 区间调用 read_file。`,
  ].join("\n");
}

/* =========================================================================
 * 上下文压缩：messages 只增不减会在长任务里撑爆窗口
 * 策略：保留 system + 任务 + 最近 N 条工具输出，较早的工具输出折叠成摘要。
 * 只改 content，不动 tool_call_id 配对，所以协议始终合法。
 * ========================================================================= */
export function compactMessages(
  messages: Msg[],
  ctx?: ToolCtx, // Pass `ctx` so emergency compaction can also build receipts
  budget = CONTEXT_CHAR_BUDGET,
  keepRecent = 8
): number {
  let total = messages.reduce((s, m) => s + msgSize(m), 0);
  if (total <= budget) return 0;

  // 1. Map tool_call_id -> { name, filePath } just like in foldOldToolOutputs
  const callMeta = new Map<string, { name: string; filePath?: string }>();
  for (const m of messages as any[]) {
    if (!Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name;
      if (!name) continue;
      let filePath: string | undefined;
      if (name === "read_file" && typeof tc.function?.arguments === "string") {
        try {
          const args = JSON.parse(tc.function.arguments);
          filePath = args.path ?? args.file_path ?? args.p;
        } catch { /* ignore */ }
      }
      callMeta.set(tc.id, { name, filePath });
    }
  }

  const memories = ctx ? getFileMemories(ctx) : undefined;
  const renderedReceipts = new Set<string>();

  // Pre-populate renderedReceipts with any receipts already present in the message list
  // so we don't duplicate them during compaction
  for (const m of messages as any[]) {
    if (m.role === "tool" && typeof m.content === "string" && m.content.startsWith("[文件上下文回执")) {
      const meta = m.tool_call_id ? callMeta.get(m.tool_call_id) : undefined;
      if (meta?.filePath) renderedReceipts.add(meta.filePath);
    }
  }

  let folded = 0;
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const foldable = toolIdx.slice(0, Math.max(toolIdx.length - keepRecent, 0));

  for (const i of foldable) {
    if (total <= budget) break;
    const m = messages[i] as any;
    if (typeof m.content !== "string") continue;

    // 2. PROTECT EXISTING RECEIPTS: Do not overwrite them with "如需请重新调用工具"!
    if (
      m.content.startsWith("[文件上下文回执") ||
      m.content.startsWith("[已合并至上方")
    ) {
      continue;
    }

    const meta = m.tool_call_id ? callMeta.get(m.tool_call_id) : undefined;

    // 3. If this is an un-folded `read_file` output, convert it into a Context Receipt
    if (meta?.name === "read_file" && meta.filePath && memories?.has(meta.filePath)) {
      const before = m.content.length;
      if (renderedReceipts.has(meta.filePath)) {
        m.content = `[已合并至上方 ${meta.filePath} 的文件上下文回执中，请勿重复读取]`;
      } else {
        m.content = buildContextReceipt(memories.get(meta.filePath)!);
        renderedReceipts.add(meta.filePath);
      }
      total -= before - m.content.length;
      folded++;
      continue;
    }

    // 4. Generic fallback for other large tool outputs (avoid re-read triggers)
    if (m.content.length < 400 || m.content.startsWith("[较早的工具输出已折叠")) continue;
    const before = m.content.length;
    m.content = `[较早的工具输出已折叠，原 ${before} 字符；关键结论请查阅 save_notes，勿盲目重复调用] ${m.content.slice(0, 160).replace(/\s+/g, " ")}…`;
    total -= before - m.content.length;
    folded++;
  }

  // 5. 仍超预算：折叠较早 assistant 里体积很大的 write_file / edit_file 参数
  if (total > budget) {
    const cut = messages.length - keepRecent * 2;
    for (let i = 2; i < cut && total > budget; i++) {
      const m = messages[i] as any;
      for (const tc of m.tool_calls ?? []) {
        const raw: string = tc.function?.arguments ?? "";
        if (raw.length < 2000) continue;
        try {
          const a = JSON.parse(raw);
          for (const k of ["content", "old_text", "new_text"]) {
            if (typeof a[k] === "string" && a[k].length > 500) {
              a[k] = `[已折叠 ${a[k].length} 字符：已写入磁盘]`;
            }
          }
          const next = JSON.stringify(a);
          total -= raw.length - next.length;
          tc.function.arguments = next;
          folded++;
        } catch { /* 参数本来就不是合法 JSON，不动它 */ }
      }
    }
  }

  return folded;
}

/**
 * 提前折叠：写大文件的任务里，每个 write_file 的整份内容都留在历史里、每一步都被重新发给模型——
 * 但这些文件已经在磁盘上了（需要时 read_file 即可）。历史长到预算的 EARLY_FOLD_RATIO 就开始折叠
 * 较早的 write_file/edit_file 大参数（最近 3 轮保留原样；保持 JSON 合法，路径等字段不动）。
 * 比"超预算才折叠"早得多：每步少发几万字符，就是每步少等几秒的预填充时间。
 */
export function foldOldToolOutputs(
  messages: Msg[],
  ctx?: ToolCtx, // Pass `ctx` here so we can look up FileMemory!
  budget = CONTEXT_CHAR_BUDGET,
  keepRecent = 10,
  minLen = 1500
): number {
  let total = messages.reduce((s, m) => s + msgSize(m), 0);
  if (total < budget * EARLY_FOLD_RATIO) return 0;

  // 1. Build a lookup map: tool_call_id -> { name, filePath } from assistant messages
  const callMeta = new Map<string, { name: string; filePath?: string }>();
  for (const m of messages as any[]) {
    if (!Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name;
      if (!name) continue;
      let filePath: string | undefined;
      if (name === "read_file" && typeof tc.function?.arguments === "string") {
        try {
          const args = JSON.parse(tc.function.arguments);
          // Match whatever parameter name your read_file schema uses (e.g. path, file_path, p)
          filePath = args.path ?? args.file_path ?? args.p;
        } catch { /* ignore malformed json */ }
      }
      callMeta.set(tc.id, { name, filePath });
    }
  }

  const memories = ctx ? getFileMemories(ctx) : undefined;
  const renderedReceipts = new Set<string>();

  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const old = toolIdx.slice(0, Math.max(toolIdx.length - keepRecent, 0));
  let folded = 0;

  for (const i of old) {
    const m = messages[i] as any;
    if (typeof m.content !== "string") continue;

    const meta = m.tool_call_id ? callMeta.get(m.tool_call_id) : undefined;

    // 2. Special handling for `read_file` outputs using Context Receipts
    if (meta?.name === "read_file" && meta.filePath && memories?.has(meta.filePath)) {
      const before = m.content.length;

      // Multi-read merging: If we already rendered the unified receipt for this file
      // in an earlier folded message, collapse subsequent reads into a tiny pointer.
      if (renderedReceipts.has(meta.filePath)) {
        const pointer = `[已合并至上方 ${meta.filePath} 的文件上下文回执中，请勿重复读取]`;
        if (m.content !== pointer) {
          m.content = pointer;
          total -= before - m.content.length;
          folded++;
        }
        continue;
      }

      // First folded occurrence of this file: update it with the latest merged receipt!
      // (Note: Even if it was already folded on an earlier turn, we refresh it here so
      // newly read ranges get merged into this single receipt.)
      const receipt = buildContextReceipt(memories.get(meta.filePath)!);
      if (before >= minLen || m.content.startsWith("[文件上下文回执")) {
        if (m.content !== receipt) {
          m.content = receipt;
          total -= before - m.content.length;
          folded++;
        }
        renderedReceipts.add(meta.filePath);
      }
      continue;
    }

    // 3. Fallback for non-read_file large outputs (search_code, bash, etc.)
    if (m.content.length < minLen || m.content.startsWith("[较早的工具输出已折叠")) continue;
    const before = m.content.length;
    m.content = `[较早的工具输出已折叠，原 ${before} 字符；关键结论请查阅 save_notes] ${m.content.slice(0, 400).replace(/\s+/g, " ")}…`;
    total -= before - m.content.length;
    folded++;
  }

  return folded;
}

/**
 * 提前折叠：写大文件的任务里，每个 write_file 的整份内容都留在历史里、每一步都被重新发给模型——
 * 但这些文件已经在磁盘上了（需要时 read_file 即可）。历史长到预算的 EARLY_FOLD_RATIO 就开始折叠
 * 较早的 write_file/edit_file 大参数（最近 3 轮保留原样；保持 JSON 合法，路径等字段不动）。
 * 比"超预算才折叠"早得多：每步少发几万字符，就是每步少等几秒的预填充时间。
 */
export function foldOldWrites(
  messages: Msg[],
  ctx?: ToolCtx, // Pass `ctx` so we can mark modified files in FileMemory
  budget = CONTEXT_CHAR_BUDGET,
  keepRecentTurns = 3
): number {
  let total = messages.reduce((s, m) => s + msgSize(m), 0);
  if (total < budget * EARLY_FOLD_RATIO) return 0;

  const memories = ctx ? getFileMemories(ctx) : undefined;
  const turns = messages.map((m, i) => ((m as any).tool_calls?.length ? i : -1)).filter((i) => i >= 0);
  const old = turns.slice(0, Math.max(turns.length - keepRecentTurns, 0));
  let folded = 0;

  for (const i of old) {
    for (const tc of (messages[i] as any).tool_calls ?? []) {
      const name = tc.function?.name;
      if (name !== "write_file" && name !== "edit_file") continue;
      const raw: string = tc.function?.arguments ?? "";
      if (raw.length < 1200) continue;

      try {
        const a = JSON.parse(raw);
        const filePath: string | undefined = a.path ?? a.file_path ?? a.p;

        for (const k of ["content", "old_text", "new_text"]) {
          if (typeof a[k] === "string" && a[k].length > 500) {
            // Change the hint so it doesn't trigger blind re-reads
            a[k] = `[已折叠 ${a[k].length} 字符：已成功写入磁盘；仅在后续仍需修改该文件且忘记具体行号时，才分段 read_file]`;
          }
        }

        // If this file had an older read receipt, mark its memory as stale so the LLM knows line numbers shifted
        if (filePath && memories?.has(filePath)) {
          const mem = memories.get(filePath)!;
          mem.mtimeMs = -1; // Forces fresh outline extraction if ever read again
        }

        const next = JSON.stringify(a);
        total -= raw.length - next.length;
        tc.function.arguments = next;
        folded++;
      } catch { /* 参数不是合法 JSON：不动 */ }
    }
  }
  return folded;
}
