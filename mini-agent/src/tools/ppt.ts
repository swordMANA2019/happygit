import path from "node:path";
import {
  callPptTool, pptAvailable as sdkPptAvailable, pptDetected, warmPptDetection, pptErrorText, PPT_TOOL_NAMES, type PptHost,
} from "@mini-agent/ppt-sdk";
import { client } from "../llm.js";
import { VISION_MODEL, PPT_ENABLED, ASSETS_DIRS, extraBodyFor } from "../config.js";
import type { ToolCtx } from "./context.js";
import { resolveForRead, isReadable } from "./fs.js";

/**
 * PowerPoint 能力本身（COM 桥、编辑、规则检查、素材搜索、实时监视、工具定义与处理）都在 @mini-agent/ppt-sdk 里，
 * 和 mini-agent 无关。这里只做"适配"：把 mini-agent 的权限/授权、视觉模型、目录约定、环境变量接给 SDK。
 */

/** AGENT_PPT=0 关闭，=1 强制开启，不设 = 自动检测（Windows + 桌面版 PowerPoint） */
export const pptAvailable = (): boolean => sdkPptAvailable(PPT_ENABLED === "0" ? false : PPT_ENABLED === "1" ? true : undefined);

/** 不阻塞的版本（给启动路径用）：已检测过用缓存；强制开关照常生效；没检测过先当"没有"，warmPpt() 完成后再更新 */
export const pptAvailableNow = (): boolean => {
  if (PPT_ENABLED === "0") return false;
  if (PPT_ENABLED === "1") return sdkPptAvailable(true);
  return pptDetected() ?? false;
};
/** 后台检测 PowerPoint，完成后返回结果（缓存给 pptAvailable 用） */
export const warmPpt = (): Promise<boolean> => (PPT_ENABLED === "0" || PPT_ENABLED === "1" ? Promise.resolve(pptAvailable()) : warmPptDetection());

export const pptErr = pptErrorText;
export const PPT_NAMES: ReadonlySet<string> = new Set<string>(PPT_TOOL_NAMES);

/** 修改前备份、自测草稿区都放在项目的 .agent/ 下（该目录不计入"用户的改动"） */
export const pptBackupDir = (root: string) => path.join(root, ".agent", "backups", "ppt");
const pptScratchDir = (root: string) => path.join(root, ".agent", "scratch", "ppt");

/** 把一次工具调用的上下文（ToolCtx）变成 SDK 需要的宿主接口 */
export function pptHostFor(ctx: ToolCtx, opts: { attachImage?: boolean } = {}): PptHost {
  const ppt = ctx.ppt;
  if (!ppt) throw new Error("当前环境没有启用 PowerPoint 控制（仅 Windows + 桌面版 PowerPoint；AGENT_PPT=0 会关闭）。");
  return {
    ppt,
    root: ctx.root,
    scratchDir: pptScratchDir(ctx.root),
    backupDir: pptBackupDir(ctx.root),
    readOnly: ctx.mode === "ask",
    assetDirs: ASSETS_DIRS || [path.join(ctx.root, "assets"), path.join(ctx.root, ".agent", "assets")],
    onAssetDirs: (dirs) => { for (const d of dirs) ctx.extraRoots.add(d); },
    signal: ctx.signal,
    // 图片/演示文稿的读取走 mini-agent 的统一授权（项目外路径需要用户同意）
    resolvePath: async (p) => {
      const r = await resolveForRead(ctx, p);
      return isReadable(r) ? { path: r.abs } : { error: r.note };
    },
    visionName: VISION_MODEL || undefined,
    vision: VISION_MODEL
      ? async ({ png, system, user, signal }) => {
          const resp = await client.chat.completions.create({
            ...extraBodyFor(VISION_MODEL),
            model: VISION_MODEL,
            temperature: 0.2,
            max_tokens: 900,
            messages: [
              { role: "system", content: system },
              { role: "user", content: [
                { type: "text", text: user },
                { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
              ] },
            ],
          } as any, { signal }) as any;
          return String(resp.choices?.[0]?.message?.content ?? "");
        }
      : undefined,
    attachImage: process.env.AGENT_VISION === "1" || opts.attachImage
      ? (info) => { ctx.pendingImages.push(info); return true; }
      : undefined,
    noVisionHint: "设置 AGENT_VISION_MODEL=<支持图片的模型名>（推荐，点评由它完成），或 AGENT_VISION=1（主模型自己看图）。",
  };
}

/** agent.ts 的 dispatch 调用：永不抛异常 */
export async function runPptTool(ctx: ToolCtx, name: string, args: any, opts: { attachImage?: boolean } = {}): Promise<string> {
  if (!ctx.ppt) return "[PowerPoint] 当前环境没有启用 PowerPoint 控制（仅 Windows + 桌面版 PowerPoint；AGENT_PPT=0 会关闭）。";
  return (await callPptTool(pptHostFor(ctx, opts), name, args)) ?? `[未知工具] ${name}`;
}
