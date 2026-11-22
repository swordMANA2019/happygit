import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openExternal } from "./diffview.js";
import { findCustomIcon, defaultDataDir } from "./icon.js";
import { ASSETS } from "./web/assets.generated.js";

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
 * 独立 profile 目录：避免被用户已运行的 Chrome 接管成普通标签页。
 * AGENT_UI_PROFILE 可覆盖默认位置。
 */
export function appProfileDir(): string {
  const forced = process.env.AGENT_UI_PROFILE;
  if (forced) { fs.mkdirSync(forced, { recursive: true }); return forced; }
  const base = process.platform === "win32"
    ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : (process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"));
  const dir = path.join(base, "mini-agent-ui");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build the Exec command for the .desktop file.
 * - Compiled binary (bun build --compile): process.execPath IS the app, use it directly.
 * - Dev mode (node/bun running src/index.ts): need runtime + script path.
 */
function buildDesktopExec(): string {
  const exe = process.execPath;
  const base = path.basename(exe);
  // Compiled standalone binary: name is "mini-agent" (or "mini-agent.exe"), not "node"/"bun"
  if (!/^(node|bun)(\.exe)?$/i.test(base)) return `"${exe}"`;
  // Dev mode: runtime + entry script
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.resolve(scriptDir, "..", "index.js");
  return `"${exe}" "${entry}"`;
}

/**
 * Linux only: install a .desktop file + icon so the --app window shows its own
 * taskbar/dock entry with the Mini Agent icon instead of Chrome's.
 * Idempotent – safe to call on every launch.
 * Failures are logged to stderr but never block the launch.
 */
function ensureLinuxDesktopIntegration(): void {
  if (process.platform !== "linux") return;
  try {
    // 1. Resolve icon content (custom > built-in from embedded assets)
    const dataDir = defaultDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const custom = findCustomIcon(dataDir);
    let iconSvg: string | undefined;
    if (custom) {
      iconSvg = fs.readFileSync(custom.file, "utf-8");
    } else {
      const asset = ASSETS["/icon.svg"];
      if (asset) iconSvg = asset.body;
    }

    // 2. Resolve PNG icon (for DEs that don't support SVG icons reliably)
    const pngAsset = ASSETS["/icon.png"];
    const iconPng: Buffer | undefined = pngAsset ? Buffer.from(pngAsset.body, "base64") : undefined;

    // 3. Install icons into the standard hicolor theme directory so GNOME/KDE
    //    can resolve them by name (absolute paths are unreliable in .desktop files).
    //    Write both SVG and PNG; PNG is preferred by most DEs for taskbar/dock.
    const iconName = "mini-agent";
    let iconRef = "";
    if (iconSvg || iconPng) {
      const sizes = ["48x48", "64x64", "128x128", "256x256"];
      for (const size of sizes) {
        const dir = path.join(os.homedir(), ".local", "share", "icons", "hicolor", size, "apps");
        fs.mkdirSync(dir, { recursive: true });
        if (iconSvg) fs.writeFileSync(path.join(dir, `${iconName}.svg`), iconSvg, "utf-8");
        if (iconPng) fs.writeFileSync(path.join(dir, `${iconName}.png`), iconPng);
      }
      // Also keep copies in the data dir for diagnostics
      if (iconSvg) fs.writeFileSync(path.join(dataDir, "icon.svg"), iconSvg, "utf-8");
      if (iconPng) fs.writeFileSync(path.join(dataDir, "icon.png"), iconPng);
      iconRef = iconName;
    }

    // 3. Write .desktop file using the icon *name* (not an absolute path)
    const appsDir = path.join(os.homedir(), ".local", "share", "applications");
    fs.mkdirSync(appsDir, { recursive: true });
    const desktopFile = path.join(appsDir, "mini-agent.desktop");
    const execCmd = buildDesktopExec();
    const lines = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Mini Agent",
      "Comment=Mini Agent AI Assistant",
      `Exec=${execCmd}`,
      iconRef ? `Icon=${iconRef}` : "",
      "Terminal=false",
      "Categories=Development;Utility;",
      "StartupWMClass=mini-agent",
      "",
    ].filter(Boolean);
    fs.writeFileSync(desktopFile, lines.join("\n"), "utf8");

    // 4. Refresh the desktop icon cache so the new icon is picked up immediately
    try {
      const iconThemeDir = path.join(os.homedir(), ".local", "share", "icons", "hicolor");
      spawn("gtk-update-icon-cache", ["-f", "-t", iconThemeDir], { stdio: "ignore" }).unref();
    } catch { /* best-effort */ }
  } catch (err) {
    // Best-effort: log the failure so it can be diagnosed, but never block launch
    try { process.stderr.write(`[mini-agent] Linux desktop integration failed: ${err instanceof Error ? err.message : String(err)}\n`); } catch { /* no console available */ }
  }
}

/**
 * 打开界面窗口。优先 Chromium 的 --app 模式（独立窗口、无地址栏，看起来就是桌面程序，
 * 音视频/硬件解码也最完整）；没有就退回系统默认浏览器的普通标签页。
 * 关键：必须用独立 --user-data-dir，否则已运行的 Chrome 会忽略 --app 直接开标签页。
 * 返回实际采用的方式：app | browser | none（都失败，调用方把网址打印出来）。
 */
export async function openAppWindow(url: string): Promise<"app" | "browser" | "none"> {
  ensureLinuxDesktopIntegration();
  const exe = findAppBrowser();
  if (exe) {
    try {
      const profile = appProfileDir();
      const args = [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        "--window-size=1280,860",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--new-window",
        // Linux: set WM_CLASS so the window gets its own taskbar entry & icon (not grouped with Chrome)
        ...(process.platform === "linux" ? ["--class=mini-agent"] : []),
      ];
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(exe, args, { detached: true, stdio: "ignore" });
        p.on("error", () => resolve(false));
        p.on("spawn", () => { p.unref(); resolve(true); });
      });
      if (ok) return "app";
    } catch { /* 退回普通浏览器 */ }
  }
  return (await openExternal(url)) ? "browser" : "none";
}
