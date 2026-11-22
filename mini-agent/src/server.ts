import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AddressInfo } from "node:net";
import { INITIAL_MODEL, BACKEND, modelCatalog, resolveModel, type ModelOption } from "./config.js";
import { uiContext, type TraceEvent } from "./trace.js";
import { openServerLog } from "./ui/server-log.js";
import { PptWatcher, formatWatchEvent } from "@mini-agent/ppt-sdk";
import { pptAvailableNow, pptBackupDir, warmPpt } from "./tools/ppt.js";
import { Session, type Prompter } from "./session.js";
import { handle, runBuiltin, printBanner, type CommandEnv } from "./commands.js";
import { renderHtml } from "./ui/diffview.js";
import { captureConsole } from "./ui/capture.js";
import { openAppWindow } from "./ui/launch.js";
import { findCustomIcon, defaultDataDir } from "./ui/icon.js";
import { ASSETS } from "./ui/web/assets.generated.js";

/**
 * Web / 桌面界面：一个只监听 127.0.0.1 的本地 HTTP 服务 + 一个静态页面。
 * 双击可执行文件 → 起服务 → 用浏览器的 --app 模式开一个独立窗口（见 ui/launch.ts）。
 *
 * 多对话：和 Cursor 一样，左侧是按仓库（目录）分组的对话列表。每个对话 = 一个独立的 Session
 * （自己的目录、模型、对话记忆、检查点、授权、PowerPoint 监视），可以同时运行。
 * console 输出靠 AsyncLocalStorage 归到发起它的对话，不会串台。
 *
 * 安全（agent 能执行命令、改文件，所以必须设防）：
 *  - 只绑定回环地址 + 校验 Host（防 DNS rebinding）
 *  - 每次启动随机令牌：首次访问 /?t=令牌 → 种 HttpOnly + SameSite=Strict cookie → 之后所有请求都要带它
 *  - 所有 POST 必须带合法的 Origin（防跨站请求）
 *  - /file 只提供对话所在项目目录内的媒体/图片/PDF，且禁止目录穿越与符号链接逃逸
 */

export type UiState = {
  model: string; cwd: string; sessionId: string; backend: string;
  ppt: boolean; watching: boolean; busy: boolean; chat?: string;
};

/** 侧边栏里一个对话的摘要 */
export type ChatInfo = {
  id: string; title: string; cwd: string; repo: string; model: string; backend: string; busy: boolean; turns: number;
};

export type UiEvent =
  | { t: "out"; chat?: string; stream: "out" | "err" | "notice"; text: string }
  | { t: "trace"; chat?: string; ev: TraceEvent; ts?: number }
  | { t: "user"; chat?: string; text: string }
  | { t: "ask"; chat?: string; id: number; question: string }
  | { t: "askdone"; chat?: string; id: number }
  | { t: "busy"; chat?: string; busy: boolean }
  | { t: "state"; chat?: string; state: UiState }
  | { t: "diff"; chat?: string; id: string; title: string; files: number }
  | { t: "chats"; chats: ChatInfo[]; repos: string[]; models: ModelOption[] }
  | { t: "removed"; chat: string }
  | { t: "bye" };

export type UiServerOptions = {
  cwd?: string;
  /** 是否接管 console 输出（真正运行时是；测试里按需） */
  captureConsole?: boolean;
  /** 注入 Session（测试用）；作为第一个对话 */
  session?: Session;
  /** 数据目录（保存仓库列表、放自定义图标）。缺省 ~/.mini-agent；null = 不读写（测试） */
  dataDir?: string | null;
  /** 命令执行器（测试用）；缺省走真正的命令层 */
  exec?: (ses: Session, watcher: PptWatcher, input: string, env: CommandEnv) => Promise<"exit" | "handled">;
};

export type UiServer = {
  url: string;           // 带令牌的入口地址（给浏览器第一次打开用）
  baseUrl: string;       // 不带令牌
  token: string;
  port: number;
  /** 第一个对话的 Session（兼容旧用法；其它对话见 chats()） */
  ses: Session;
  prompter: Prompter;
  chats(): ChatInfo[];
  /** 页面连接情况：用事件记录而不是轮询，快速的连上/断开也不会漏 */
  activity(): { clients: number; everConnected: boolean; lastSeen: number };
  close(): Promise<void>;
  onBye(fn: () => void): void;
};

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
  ".pdf": "application/pdf",
};

const MAX_BODY = 1_000_000;
const BACKLOG_MAX = 4000;
const TITLE_MAX = 30;

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const normPath = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);

function inside(root: string, p: string): boolean {
  const r = normPath(root), q = normPath(p);
  return q === r || q.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 用第一句"真正的任务"当对话标题；/ask /fix 之类的模式前缀去掉，纯命令（/pwd）不算 */
export function deriveTitle(text: string): string {
  let t = text.trim();
  const m = /^\/(ask|fix|edit|diag)\s+/i.exec(t);
  if (m) t = t.slice(m[0].length);
  else if (t.startsWith("/")) return "";
  t = t.replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + "…" : t;
}

type Chat = {
  id: string;
  ses: Session;
  watcher: PptWatcher;
  env: CommandEnv;
  title: string;
  running: boolean;
  backlog: UiEvent[];
};

export async function startServer(opts: UiServerOptions = {}): Promise<UiServer> {
  const token = crypto.randomBytes(24).toString("hex");
  const dataDir = opts.dataDir === undefined ? defaultDataDir() : opts.dataDir;
  const exec = opts.exec ?? (async (ses, watcher, input, env) => {
    const r = await runBuiltin(ses, watcher, input, env);
    if (r === "exit") return "exit";
    if (r === "none") await handle(ses, input);
    return "handled";
  });

  /* ---- 事件中心：每个对话各自的回放缓冲（刷新/重连后还原）+ 实时推送 ---- */
  const chats: Chat[] = [];
  const sse = new Set<http.ServerResponse>();
  let everConnected = false;
  let lastSeen = Date.now();
  let byeSent = false;
  let closed = false;
  const send = (res: http.ServerResponse, ev: UiEvent) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* 连接已断，由 close 事件清理 */ } };
  const broadcast = (ev: UiEvent) => { for (const res of sse) send(res, ev); };
  const emitChat = (chat: Chat, ev: UiEvent) => {
    const tagged = { ...ev, chat: chat.id, ts: Date.now() } as UiEvent;
    const last = chat.backlog[chat.backlog.length - 1];
    if (tagged.t === "out" && last && last.t === "out" && last.stream === tagged.stream) chat.backlog[chat.backlog.length - 1] = { ...last, text: last.text + tagged.text };
    // 流式思考的增量在回放缓冲里合并成一条：刷新页面后是一整段，而不是几百条碎片
    else if (tagged.t === "trace" && last && last.t === "trace" && tagged.ev.kind === "thought" && tagged.ev.append && last.ev.kind === "thought" && last.ev.id === tagged.ev.id && last.ev.append && !last.ev.done) {
      chat.backlog[chat.backlog.length - 1] = { ...last, ev: { ...last.ev, text: last.ev.text + tagged.ev.text } };
    } else chat.backlog.push(tagged);
    if (chat.backlog.length > BACKLOG_MAX) chat.backlog.splice(0, chat.backlog.length - BACKLOG_MAX);
    broadcast(tagged);
  };

  /* ---- 仓库列表（只记路径；对话本身不落盘，对话内容靠各目录的 /resume） ---- */
  const reposFile = dataDir ? path.join(dataDir, "repos.json") : null;
  const repos: string[] = [];
  const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const hasRepo = (p: string) => repos.some((r) => normPath(r) === normPath(p));
  const saveRepos = () => {
    if (!reposFile) return;
    try { fs.mkdirSync(path.dirname(reposFile), { recursive: true }); fs.writeFileSync(reposFile, JSON.stringify({ repos }, null, 2), "utf8"); } catch { /* 存不下不影响使用 */ }
  };
  const noteRepo = (p: string) => { if (!hasRepo(p)) { repos.push(p); saveRepos(); } };
  if (reposFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(reposFile, "utf8")).repos;
      if (Array.isArray(saved)) for (const r of saved) if (typeof r === "string" && isDir(r) && !hasRepo(r)) repos.push(r);
    } catch { /* 第一次运行 */ }
  }

  const chatInfo = (c: Chat): ChatInfo => ({
    id: c.id, title: c.title, cwd: c.ses.cwd, repo: path.basename(c.ses.cwd) || c.ses.cwd,
    model: c.ses.model, backend: c.ses.backend, busy: c.running, turns: c.ses.turns,
  });
  const modelChoices = (): ModelOption[] => {
    const catalog = modelCatalog();
    const seen = new Set(catalog.map((m) => `${m.backend}:${m.id}`));
    for (const c of chats) {
      const key = `${c.ses.backend}:${c.ses.model}`;
      if (!seen.has(key)) { catalog.push({ id: c.ses.model, backend: c.ses.backend }); seen.add(key); }
    }
    return catalog;
  };
  const serverLog = openServerLog(dataDir);
  const chatsEvent = (): UiEvent => {
    for (const c of chats) noteRepo(c.ses.cwd);       // /cd 之后目录变了：新目录也记进仓库列表
    return { t: "chats", chats: chats.map(chatInfo), repos: [...repos], models: modelChoices() };
  };
  const emitChats = () => broadcast(chatsEvent());

  /* ---- 输出归属：console.* 属于"调用它时所在的对话"（AsyncLocalStorage 跨 await 保持） ---- */
  const owner = new AsyncLocalStorage<Chat>();
  let lastActive: Chat | null = null;
  const fallbackChat = () => (lastActive && chats.includes(lastActive) ? lastActive : chats[0]);
  const stopCapture = opts.captureConsole === false ? () => {} : captureConsole((c) => {
    const chat = owner.getStore() ?? fallbackChat();
    if (!chat) return;
    serverLog.backend(chat.id, c.stream, c.text);
    // 界面里：任务执行中 console.* 只写后端日志；测试/未挂 uiContext 时仍推到 SSE（兼容假 exec 里的 console.log）
    if (!uiContext.getStore()) emitChat(chat, { t: "out", stream: c.stream, text: c.text });
  });

  /* ---- 提问（审批等）：每个对话各自的 prompter，答案按全局唯一 id 对应 ---- */
  const pending = new Map<number, { chat: string; settle: (answer: string) => void }>();
  let askSeq = 0;
  const prompterFor = (chat: () => Chat): Prompter => ({
    ask: (question, signal) => new Promise<string>((resolve) => {
      const id = ++askSeq;
      const settle = (answer: string) => { if (pending.delete(id)) { emitChat(chat(), { t: "askdone", id }); resolve(answer); } };
      pending.set(id, { chat: chat().id, settle });
      signal?.addEventListener("abort", () => settle(""), { once: true });   // 中断 = 拒绝，不能默认同意
      emitChat(chat(), { t: "ask", id, question });
    }),
  });
  const refuseAsks = (chatId?: string) => { for (const p of [...pending.values()]) if (!chatId || p.chat === chatId) p.settle(""); };

  const diffPages = new Map<string, string>();
  const state = (c: Chat): UiState => ({
    model: c.ses.model, cwd: c.ses.cwd, sessionId: c.ses.sessionId, backend: c.ses.backend,
    ppt: pptAvailableNow(), watching: c.watcher.running, busy: c.running, chat: c.id,
  });
  const setBusy = (c: Chat, b: boolean) => {
    c.running = b;
    emitChat(c, { t: "busy", busy: b });
    emitChat(c, { t: "state", state: state(c) });
    emitChats();
  };

  function createChat(cwd: string, model?: string, session?: Session): Chat {
    const id = crypto.randomBytes(4).toString("hex");
    let chat!: Chat;
    const prompter = prompterFor(() => chat);
    const seed = model?.trim() || INITIAL_MODEL;
    const choice = resolveModel(seed, BACKEND);
    const ses = session ?? new Session(cwd, choice.id, prompter);
    if (!session) ses.useModel(choice.id, choice.backend);
    if (session) session.prompter = prompter;
    const watcher = new PptWatcher({
      ppt: ses.ppt,
      backupDir: () => pptBackupDir(ses.cwd),
      busy: () => ses.busy,
      pollMs: Number(process.env.AGENT_WATCH_POLL_MS) || undefined,
      debounceMs: Number(process.env.AGENT_WATCH_DEBOUNCE_MS) || undefined,
    });
    watcher.on("issues", (e) => emitChat(chat, { t: "out", stream: "notice", text: `${formatWatchEvent(e)}\n` }));
    watcher.on("stopped", () => emitChat(chat, { t: "out", stream: "notice", text: "[watch] 连续多次无法读取 PowerPoint，已停止监视（/watch ppt 可重新开启）。\n" }));
    chat = {
      id, ses, watcher, title: "", running: false, backlog: [],
      env: {
        showDiffs: async (diffs, title) => {
          const pid = crypto.randomBytes(6).toString("hex");
          diffPages.set(pid, renderHtml(diffs, title));
          while (diffPages.size > 20) diffPages.delete(diffPages.keys().next().value as string);
          emitChat(chat, { t: "diff", id: pid, title, files: diffs.length });
        },
      },
    };
    chats.push(chat);
    noteRepo(ses.cwd);
    return chat;
  }

  function closeChat(chat: Chat, keepOne = true) {
    const i = chats.indexOf(chat);
    if (i < 0) return;
    chat.ses.interrupt();
    refuseAsks(chat.id);
    chat.watcher.stop();
    chat.ses.dispose();
    chats.splice(i, 1);
    broadcast({ t: "removed", chat: chat.id });
    if (!chats.length && keepOne) createChat(chat.ses.cwd);       // 界面里永远至少有一个对话
    emitChats();
  }

  const first = createChat(opts.session?.cwd ?? opts.cwd ?? process.cwd(), undefined, opts.session);
  const byeHandlers: Array<() => void> = [];

  const thoughtLog = new Map<string, string>();
  async function runInput(chat: Chat, text: string) {
    lastActive = chat;
    if (!chat.title) { const t = deriveTitle(text); if (t) chat.title = t; }
    emitChat(chat, { t: "user", text });
    setBusy(chat, true);
    try {
      await owner.run(chat, () => uiContext.run({
        say: (s) => emitChat(chat, { t: "out", stream: "out", text: s }),
        trace: (ev) => {
          // 后端日志里一段流式思考只记一行：攒到结束再写
          if (ev.kind === "thought" && ev.id && (ev.append || ev.done)) {
            thoughtLog.set(ev.id, (thoughtLog.get(ev.id) ?? "") + ev.text);
            if (ev.done) { serverLog.react(chat.id, { kind: "thought", step: ev.step, text: thoughtLog.get(ev.id)! }); thoughtLog.delete(ev.id); }
          } else serverLog.react(chat.id, ev);
          emitChat(chat, { t: "trace", ev });
        },
      }, async () => {
        const r = await exec(chat.ses, chat.watcher, text, chat.env);
        if (r === "exit") { byeSent = true; broadcast({ t: "bye" }); for (const f of byeHandlers) setTimeout(f, 300); }
      }));
    } catch (e: any) {
      emitChat(chat, { t: "out", stream: "notice", text: `[错误] ${e?.message ?? e}\n` });
    } finally {
      setBusy(chat, false);
    }
  }

  /* ---- HTTP ---- */
  let port = 0;
  const hostOk = (req: http.IncomingMessage) => {
    const h = (req.headers.host ?? "").toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };
  const originOk = (req: http.IncomingMessage, required: boolean) => {
    const o = req.headers.origin;
    if (!o) return !required;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  };
  const cookieOk = (req: http.IncomingMessage) => {
    const m = /(?:^|;\s*)ma=([0-9a-f]+)/.exec(req.headers.cookie ?? "");
    return Boolean(m) && safeEq(m![1], token);
  };

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readJson = (req: http.IncomingMessage) => new Promise<any>((resolve, reject) => {
    let size = 0; const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch { reject(new Error("invalid json")); } });
    req.on("error", reject);
  });

  /** 请求里没带 chat = 第一个对话（旧客户端 / 测试的写法） */
  const pick = (id: unknown): Chat | undefined => (id === undefined || id === null || id === "" ? chats[0] : chats.find((c) => c.id === String(id)));

  const PAGE_CSP = "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

  function serveIcon(res: http.ServerResponse, head: boolean, preferPng: boolean) {
    // Prefer PNG when explicitly requested (/icon.png) or when the client
    // accepts image/png (browsers on Windows/macOS handle PNG favicons more
    // reliably than SVG). Fall back to SVG otherwise.
    const pngAsset = ASSETS["/icon.png"];
    const svgAsset = ASSETS["/icon.svg"];
    const usePng = preferPng && pngAsset;
    const custom = findCustomIcon(dataDir);
    let type: string, body: Buffer | string;
    try {
      if (custom) { type = custom.type; body = fs.readFileSync(custom.file); }
      else if (usePng) { type = pngAsset.type; body = Buffer.from(pngAsset.body, "base64"); }
      else { type = svgAsset.type; body = svgAsset.body; }
    } catch {
      if (usePng) { type = pngAsset.type; body = Buffer.from(pngAsset.body, "base64"); }
      else { type = svgAsset.type; body = svgAsset.body; }
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" });
    res.end(head ? undefined : body);
  }

  function serveFile(req: http.IncomingMessage, res: http.ServerResponse, ses: Session, rel: string) {
    let real: string, root: string;
    try {
      root = fs.realpathSync(ses.cwd);
      real = fs.realpathSync(path.resolve(ses.cwd, rel));
    } catch { res.writeHead(404).end(); return; }
    const type = MEDIA_TYPES[path.extname(real).toLowerCase()];
    if (!type || !inside(root, real)) { res.writeHead(404).end(); return; }
    let st: fs.Stats;
    try { st = fs.statSync(real); } catch { res.writeHead(404).end(); return; }
    if (!st.isFile()) { res.writeHead(404).end(); return; }
    const headers: Record<string, string | number> = {
      "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "content-security-policy": "sandbox",
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { "content-range": `bytes */${st.size}` }).end(); return; }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(real, { start, end }).on("error", () => res.destroy()).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": st.size });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(real).on("error", () => res.destroy()).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) { res.writeHead(403).end("bad host"); return; }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const isPost = req.method === "POST";

      // 入口：带令牌的地址 → 种 cookie → 跳转到干净的地址
      const t = url.searchParams.get("t");
      if (url.pathname === "/" && t !== null) {
        if (!safeEq(t, token)) { res.writeHead(403).end("bad token"); return; }
        res.writeHead(302, { location: "/", "set-cookie": `ma=${token}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store" });
        res.end();
        return;
      }
      if (!cookieOk(req)) { res.writeHead(403).end("forbidden"); return; }
      if (isPost && !originOk(req, true)) { res.writeHead(403).end("bad origin"); return; }
      if (!isPost && req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }

      const asset = req.method === "GET" ? ASSETS[url.pathname] : undefined;
      if (asset && url.pathname !== "/icon.svg") {
        res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store", "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff" });
        res.end(asset.body);
        return;
      }
      if ((url.pathname === "/app-icon" || url.pathname === "/icon.svg" || url.pathname === "/icon.png" || url.pathname === "/favicon.ico") && (req.method === "GET" || req.method === "HEAD")) {
        const preferPng = url.pathname === "/icon.png" || url.pathname === "/favicon.ico";
        serveIcon(res, req.method === "HEAD", preferPng);
        return;
      }

      if (url.pathname === "/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write("retry: 1500\n\n");
        res.write(`event: reset\ndata: {}\n\n`);                     // 客户端清空后按顺序回放
        send(res, chatsEvent());
        for (const c of chats) {
          send(res, { t: "state", chat: c.id, state: state(c) });
          for (const ev of c.backlog) send(res, ev);
          send(res, { t: "state", chat: c.id, state: state(c) });
        }
        if (byeSent) send(res, { t: "bye" });
        sse.add(res);                                                // 未答复的提问已在 backlog 里；答复后的 askdone 事件会把它撤掉
        everConnected = true; lastSeen = Date.now();
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* close 会清理 */ } }, 15_000);
        req.on("close", () => { clearInterval(ping); sse.delete(res); lastSeen = Date.now(); });
        return;
      }
      if (url.pathname === "/api/state" && req.method === "GET") {
        const c = pick(url.searchParams.get("chat"));
        if (!c) { json(res, 404, { error: "no such chat" }); return; }
        json(res, 200, state(c));
        return;
      }
      if (url.pathname === "/api/chats" && req.method === "GET") {
        const ev = chatsEvent() as Extract<UiEvent, { t: "chats" }>;
        json(res, 200, { chats: ev.chats, repos: ev.repos, models: ev.models });
        return;
      }

      if (url.pathname.startsWith("/diff/") && req.method === "GET") {
        const html = diffPages.get(url.pathname.slice(6));
        if (!html) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "sandbox allow-scripts" });
        res.end(html);
        return;
      }
      if (url.pathname === "/file" && (req.method === "GET" || req.method === "HEAD")) {
        const c = pick(url.searchParams.get("chat"));
        if (!c) { res.writeHead(404).end(); return; }
        serveFile(req, res, c.ses, url.searchParams.get("p") ?? "");
        return;
      }

      if (isPost && url.pathname === "/api/input") {
        const body = await readJson(req);
        const text = String(body.text ?? "").trim();
        const c = pick(body.chat);
        if (!c) { json(res, 404, { error: "no such chat" }); return; }
        if (!text) { json(res, 400, { error: "empty" }); return; }
        if (c.running) { json(res, 409, { error: "busy" }); return; }
        void runInput(c, text);
        json(res, 202, { ok: true });
        return;
      }
      if (isPost && url.pathname === "/api/answer") {
        const body = await readJson(req);
        const p = pending.get(Number(body.id));
        if (!p) { json(res, 404, { error: "no such question" }); return; }
        p.settle(String(body.text ?? ""));
        json(res, 200, { ok: true });
        return;
      }
      if (isPost && url.pathname === "/api/interrupt") {
        const body = await readJson(req);
        const c = pick(body.chat);
        if (!c) { json(res, 404, { error: "no such chat" }); return; }
        const hit = c.ses.interrupt();
        refuseAsks(c.id);                                            // 正在等用户回答的提问按"拒绝"处理
        json(res, 200, { interrupted: hit });
        return;
      }

      /* ---- 对话管理 ---- */
      if (isPost && url.pathname === "/api/chat/new") {
        const body = await readJson(req);
        const from = pick(body.from);
        const cwd = path.resolve(String(body.cwd ?? "").trim() || from?.ses.cwd || process.cwd());
        if (!isDir(cwd)) { json(res, 400, { error: `不是有效目录：${cwd}` }); return; }
        const model = String(body.model ?? "").trim();
        const c = createChat(cwd, model || from?.ses.model);
        emitChat(c, { t: "state", state: state(c) });
        emitChats();
        json(res, 200, { id: c.id });
        return;
      }
      if (isPost && url.pathname === "/api/chat/close") {
        const body = await readJson(req);
        const c = body.chat ? pick(body.chat) : undefined;      // 关闭必须点名，不能落到"第一个对话"
        if (!c) { json(res, 404, { error: "no such chat" }); return; }
        closeChat(c);
        json(res, 200, { ok: true });
        return;
      }
      if (isPost && url.pathname === "/api/chat/model") {
        const body = await readJson(req);
        const c = pick(body.chat);
        const model = String(body.model ?? "").trim();
        if (!c) { json(res, 404, { error: "no such chat" }); return; }
        if (!model) { json(res, 400, { error: "empty model" }); return; }
        if (c.running) { json(res, 409, { error: "busy" }); return; }
        const choice = resolveModel(model, c.ses.backend);
        try { c.ses.useModel(choice.id, choice.backend); } catch (e: any) { json(res, 409, { error: String(e?.message ?? e) }); return; }
        emitChat(c, { t: "state", state: state(c) });
        emitChats();
        json(res, 200, { model: c.ses.model, backend: c.ses.backend });
        return;
      }
      if (isPost && url.pathname === "/api/repo/remove") {
        const body = await readJson(req);
        const target = String(body.cwd ?? "");
        const idx = repos.findIndex((r) => normPath(r) === normPath(target));
        if (idx < 0) { json(res, 404, { error: "no such repo" }); return; }
        if (repos.length <= 1) { json(res, 400, { error: "至少保留一个仓库" }); return; }
        for (const c of chats.filter((x) => normPath(x.ses.cwd) === normPath(target))) closeChat(c, false);
        repos.splice(idx, 1);
        saveRepos();
        if (!chats.length) createChat(repos[0]);
        emitChats();
        json(res, 200, { ok: true });
        return;
      }
      res.writeHead(404).end();
    } catch (e: any) {
      if (!res.headersSent) json(res, 400, { error: String(e?.message ?? e) });
      else res.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.AGENT_UI_PORT) || 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/`;

  if (opts.captureConsole !== false) owner.run(first, () => printBanner(first.ses));
  emitChat(first, { t: "state", state: state(first) });
  // PowerPoint 检测放后台（同步检测要起 reg.exe，会拖慢窗口出现）；结果出来后刷新各对话的状态（斜杠提示里是否有 /ppt）
  void warmPpt().then(() => { if (!closed) for (const c of chats) emitChat(c, { t: "state", state: state(c) }); }).catch(() => {});

  return {
    url: `${baseUrl}?t=${token}`, baseUrl, token, port, ses: first.ses, prompter: first.ses.prompter!,
    chats: () => chats.map(chatInfo),
    activity: () => ({ clients: sse.size, everConnected, lastSeen }),
    onBye: (fn) => { byeHandlers.push(fn); },
    close: async () => {
      closed = true;
      for (const c of chats) { c.watcher.stop(); c.ses.interrupt(); }
      refuseAsks();
      for (const c of chats) c.ses.dispose();
      for (const res of sse) { try { res.end(); } catch { /* 忽略 */ } }
      sse.clear();
      stopCapture();
      await new Promise<void>((resolve) => { server.close(() => resolve()); (server as any).closeAllConnections?.(); });
    },
  };
}

/**
 * 盯着窗口：没有页面连着 = 窗口关了，等一小会儿（容忍刷新 / 瞬时断线）后退出。
 * Edge/Chrome 的 --app 窗口常常把请求交给已运行的浏览器进程，启动器拿不到"窗口已关"的信号，
 * 所以只能靠页面的 SSE 连接来判断。刷新页面通常 <1s 就重连，EventSource 断线重试间隔是 1.5s，
 * 所以宽限期 3s 足够；以前的 15s 宽限 + 2s 轮询让"关窗口后进程还要活十几秒"。
 *  - 电脑睡眠/休眠唤醒后定时器会晚点很久，此时页面还没来得及重连：把唤醒时刻当作"刚看到过页面"，不误杀。
 *  - 启动后一直没人连上（窗口没打开成）也退出，除非 startupMs 为 0。
 */
export function watchWindow(
  ui: { activity(): { clients: number; everConnected: boolean; lastSeen: number } },
  o: { graceMs?: number; pollMs?: number; startupMs?: number; onExit: () => void },
): () => void {
  const grace = o.graceMs ?? 3000, poll = o.pollMs ?? 250;
  const startedAt = Date.now();
  let tickAt = Date.now(), resumedAt = 0, fired = false;
  const t = setInterval(() => {
    const now = Date.now();
    if (now - tickAt > Math.max(poll * 8, 4000)) resumedAt = now;      // 定时器停摆过 = 睡眠唤醒
    tickAt = now;
    if (fired) return;
    const a = ui.activity();
    if (a.clients > 0) return;
    const seen = Math.max(a.lastSeen, resumedAt);
    if ((a.everConnected && now - seen > grace) || (!a.everConnected && o.startupMs && now - startedAt > o.startupMs)) { fired = true; o.onExit(); }
  }, poll);
  t.unref?.();
  return () => clearInterval(t);
}

/** 真正的入口：起服务、开窗口，窗口关闭（没有页面连着）后自动退出 */
export async function runUi(opts: { open: boolean }): Promise<void> {
  const ui = await startServer();
  const say = (s: string) => { try { process.stderr.write(`${s}\n`); } catch { /* 无控制台（打包后隐藏窗口） */ } };
  say(`Mini Agent 界面：${ui.baseUrl}（令牌已包含在启动地址中）`);

  let launched = false;
  if (opts.open) {
    const how = await openAppWindow(ui.url);
    launched = how !== "none";
    if (how === "none") say(`无法自动打开浏览器，请手动打开：${ui.url}`);
    else if (how === "browser") say("未找到 Chrome/Edge，已用默认浏览器打开（普通标签页）。");
  } else say(`请在浏览器打开：${ui.url}`);

  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    setTimeout(() => process.exit(0), 1500).unref?.();            // 清理里任何一步卡住（外部工具进程等）也不拖住退出
    await ui.close().catch(() => {});
    process.exit(0);
  };
  ui.onBye(quit);
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  watchWindow(ui, {
    graceMs: Number(process.env.AGENT_UI_EXIT_GRACE_MS) || 3000,
    startupMs: launched ? 120_000 : 0,
    onExit: () => void quit(),
  });
}
