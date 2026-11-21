import { PPT_TOOL_DEFS, PPT_READ_NAMES } from "@mini-agent/ppt-sdk";
import { runPptTool } from "../tools/ppt.js";
import type { ToolCtx } from "../tools/ctx.js";

/**
 * 把 @mini-agent/ppt-sdk 的工具（ppt_read / ppt_edit / ppt_lint / ppt_look / asset_search / ppt_open / ppt_save）
 * 变成 Cursor Agent 的自定义工具（SDK 的 local.customTools：宿主进程里的回调，Cursor 通过 custom-user-tools 这个 MCP 服务暴露给模型）。
 * 与原生后端共用同一套处理函数和宿主钩子（授权、视觉模型、素材目录、只读限制），区别只有"怎么交给模型"。
 *
 * ask 模式只给只读的 4 个。ppt_look 的渲染图：配了 AGENT_VISION_MODEL 就由它点评；没配就把图片直接作为工具结果还给 Cursor 的模型（它能看图）。
 */
export function pptCustomTools(makeCtx: () => ToolCtx, opts: { readOnly: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const reads = new Set<string>(PPT_READ_NAMES);
  for (const def of PPT_TOOL_DEFS) {
    const name = def.function.name;
    if (opts.readOnly && !reads.has(name)) continue;
    out[name] = {
      description: def.function.description,
      inputSchema: def.function.parameters,
      execute: async (args: Record<string, unknown>) => {
        const ctx = makeCtx();
        const text = await runPptTool(ctx, name, args, { attachImage: true });
        const images = ctx.pendingImages.splice(0);
        if (!images.length) return text;
        return {
          content: [
            { type: "text", text },
            ...images.map((i) => ({ type: "image", data: i.dataUrl.replace(/^data:[^,]*,/, ""), mimeType: "image/png" })),
          ],
        };
      },
    };
  }
  return out;
}
