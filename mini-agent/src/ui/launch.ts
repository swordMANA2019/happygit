import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { openExternal } from "./diffview.js";

/** 常见的 Chromium 系浏览器：只要有一个，就能用 --app 打开"无地址栏的应用窗口" */
function candidates(): string[] {
  const env = process.env;
  if (process.platform === "win32") {
    const pf = env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = env["LocalAppData"] ?? "";
    return [
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    ].filter(Boolean) as string[];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"];
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
  }
  return null;
}

/** 找到可用的浏览器可执行文件；AGENT_UI_BROWSER 可强制指定 */
export function findAppBrowser(): string | null {
  const forced = process.env.AGENT_UI_BROWSER;
  if (forced) return forced;
  for (const c of candidates()) {
    const p = path.isAbsolute(c) ? (fs.existsSync(c) ? c : null) : findOnPath(c);
    if (p) return p;
  }
  return null;
}

/**
 * 打开界面窗口。优先 Chromium 的 --app 模式（独立窗口、无地址栏，看起来就是桌面程序，
 * 音视频/硬件解码也最完整）；没有就退回系统默认浏览器的普通标签页。
 * 返回实际采用的方式：app | browser | none（都失败，调用方把网址打印出来）。
 */
export async function openAppWindow(url: string): Promise<"app" | "browser" | "none"> {
  const exe = findAppBrowser();
  if (exe) {
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(exe, [`--app=${url}`, "--window-size=1180,820", "--no-first-run", "--no-default-browser-check"], { detached: true, stdio: "ignore" });
        p.on("error", () => resolve(false));
        p.on("spawn", () => { p.unref(); resolve(true); });
      });
      if (ok) return "app";
    } catch { /* 退回普通浏览器 */ }
  }
  return (await openExternal(url)) ? "browser" : "none";
}
