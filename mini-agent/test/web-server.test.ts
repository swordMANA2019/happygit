import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, watchWindow, type UiServer, type UiEvent } from "../src/server.js";
import { buildFileDiff } from "../src/ui/diffview.js";
import { captureConsole } from "../src/ui/capture.js";
import { findCustomIcon } from "../src/ui/icon.js";
import { deriveTitle } from "../src/server.js";
import { say, emitTrace } from "../src/trace.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-web-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ma-web-out-"));
fs.writeFileSync(path.join(tmp, "a.png"), Buffer.from("0123456789abcdef"));
fs.writeFileSync(path.join(tmp, "secret.txt"), "top secret");
fs.writeFileSync(path.join(tmp, ".env"), "KEY=1");
fs.mkdirSync(path.join(tmp, "sub"));
fs.writeFileSync(path.join(tmp, "sub", "v.mp4"), Buffer.alloc(100, 1));
fs.writeFileSync(path.join(outside, "leak.png"), "leak");

const servers: UiServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

type Exec = NonNullable<Parameters<typeof startServer>[0]>["exec"];
async function boot(exec?: Exec) {
  const ui = await startServer({ cwd: tmp, exec, dataDir: null });
  servers.push(ui);
  return ui;
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
function request(ui: UiServer, method: string, p: string, o: { cookie?: string | null; origin?: string | null; host?: string; body?: unknown; range?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${ui.port}` };
    if (o.cookie !== null) headers.cookie = o.cookie ?? `ma=${ui.token}`;
    if (o.origin !== null && method === "POST") headers.origin = o.origin ?? `http://127.0.0.1:${ui.port}`;
    if (o.range) headers.range = o.range;
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (payload) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(payload)); }
    const req = http.request({ host: "127.0.0.1", port: ui.port, method, path: p, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 打开 /events，收集事件；waitFor 等到满足条件的事件出现 */
function listen(ui: UiServer) {
  const events: UiEvent[] = [];
  const named: string[] = [];
  let buf = "";
  const waiters: Array<() => void> = [];
  const req = http.request({ host: "127.0.0.1", port: ui.port, path: "/events", headers: { host: `127.0.0.1:${ui.port}`, cookie: `ma=${ui.token}` } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(block);
        const data = /^data: (.*)$/m.exec(block);
        if (ev) named.push(ev[1]);
        else if (data) events.push(JSON.parse(data[1]));
        for (const w of waiters.splice(0)) w();
      }
    });
  });
  req.end();
  const waitFor = (pred: (e: UiEvent) => boolean, ms = 4000) => new Promise<UiEvent>((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for event; got ${JSON.stringify(events.slice(-6))}`));
      waiters.push(check);
      setTimeout(check, 50);
    };
    check();
  });
  return { events, named, waitFor, close: () => req.destroy() };
}

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; };

test("auth: token landing sets a strict cookie; everything else needs it; Host and Origin are enforced", async () => {
  const ui = await boot();
  assert.equal((await request(ui, "GET", "/", { cookie: null })).status, 403, "no cookie");
  assert.equal((await request(ui, "GET", "/?t=wrong", { cookie: null })).status, 403, "wrong token");
  const land = await request(ui, "GET", `/?t=${ui.token}`, { cookie: null });
  assert.equal(land.status, 302);
  const cookie = String(land.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const page = await request(ui, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /Mini Agent/);
  assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
  assert.equal((await request(ui, "GET", "/app.js")).status, 200);
  assert.equal((await request(ui, "GET", "/", { host: "evil.example.com" })).status, 403, "DNS rebinding host");
  assert.equal((await request(ui, "POST", "/api/input", { body: { text: "/pwd" }, origin: null })).status, 403, "POST without Origin");
  assert.equal((await request(ui, "POST", "/api/input", { body: { text: "/pwd" }, origin: "http://evil.example.com" })).status, 403, "foreign Origin");
  assert.equal((await request(ui, "POST", "/api/input", { body: { text: "/pwd" }, cookie: null })).status, 403, "POST without cookie");
});

test("input runs a built-in command through the real command layer; output, busy and state events stream; reconnect replays", async () => {
  const ui = await boot();
  const ev = listen(ui);
  await ev.waitFor((e) => e.t === "state");
  const r = await request(ui, "POST", "/api/input", { body: { text: "/pwd" } });
  assert.equal(r.status, 202);
  await ev.waitFor((e) => e.t === "user" && e.text === "/pwd");
  const out = await ev.waitFor((e) => e.t === "out" && e.text.includes(path.basename(tmp)));
  assert.equal((out as any).stream, "out");
  await ev.waitFor((e) => e.t === "busy" && e.busy === false);
  assert.equal(ev.events.some((e) => e.t === "busy" && e.busy === true), true);
  // 第二个客户端：先 reset，再回放历史
  const late = listen(ui);
  await late.waitFor((e) => e.t === "user" && e.text === "/pwd");
  assert.ok(late.named.includes("reset"));
  assert.deepEqual([ui.activity().clients, ui.activity().everConnected], [2, true]);
  ev.close(); late.close();
  for (let i = 0; i < 40 && ui.activity().clients > 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(ui.activity().clients, 0, "disconnects are tracked by event, not polling");
  assert.ok(Date.now() - ui.activity().lastSeen < 5000);
});

test("a server nobody connected to reports everConnected=false", async () => {
  const ui = await boot();
  assert.deepEqual([ui.activity().clients, ui.activity().everConnected], [0, false]);
});

test("busy: a second input while a task runs is rejected with 409; interrupt reaches the session", async () => {
  const g = gate();
  const ui = await boot(async () => { await g.p; return "handled"; });
  assert.equal((await request(ui, "POST", "/api/input", { body: { text: "first" } })).status, 202);
  assert.equal((await request(ui, "POST", "/api/input", { body: { text: "second" } })).status, 409);
  assert.equal((await request(ui, "POST", "/api/input", { body: { text: "  " } })).status, 400);
  const st = JSON.parse((await request(ui, "GET", "/api/state")).body.toString());
  assert.equal(st.busy, true);
  assert.equal(JSON.parse((await request(ui, "POST", "/api/interrupt", { body: {} })).body.toString()).interrupted, false, "no session task running");
  g.open();
  const ev = listen(ui);
  await ev.waitFor((e) => e.t === "busy" && e.busy === false);
  assert.equal((await request(ui, "POST", "/api/input", { body: { text: "third" } })).status, 202);
  ev.close();
});

test("approval round trip: ask event -> answer -> askdone; interrupt answers pending asks with a refusal", async () => {
  let got1 = "", got2 = "x";
  const ui = await boot(async (ses, _w, input) => {
    if (input === "one") got1 = await ses.prompter!.ask("应用？ [Y]es / [n]o / [a]lways: ");
    else got2 = await ses.prompter!.ask("再问一次？ [Y]es / [n]o: ");
    return "handled";
  });
  const ev = listen(ui);
  await request(ui, "POST", "/api/input", { body: { text: "one" } });
  const ask = (await ev.waitFor((e) => e.t === "ask")) as Extract<UiEvent, { t: "ask" }>;
  assert.match(ask.question, /\[Y\]es/);
  assert.equal((await request(ui, "POST", "/api/answer", { body: { id: 9999, text: "y" } })).status, 404);
  assert.equal((await request(ui, "POST", "/api/answer", { body: { id: ask.id, text: "y" } })).status, 200);
  await ev.waitFor((e) => e.t === "askdone" && e.id === ask.id);
  await ev.waitFor((e) => e.t === "busy" && e.busy === false);
  assert.equal(got1, "y");

  await request(ui, "POST", "/api/input", { body: { text: "two" } });
  const ask2 = (await ev.waitFor((e) => e.t === "ask" && e.id !== ask.id)) as Extract<UiEvent, { t: "ask" }>;
  await request(ui, "POST", "/api/interrupt", { body: {} });
  await ev.waitFor((e) => e.t === "askdone" && e.id === ask2.id);
  await ev.waitFor((e) => e.t === "busy" && e.busy === false && ev.events.filter((x) => x.t === "busy").length >= 4);
  assert.equal(got2, "", "interrupt must never default to approval");
  ev.close();
});

test("diff: showDiffs becomes an event and a sandboxed page", async () => {
  const ui = await boot(async (_s, _w, _i, env) => {
    const d = buildFileDiff({ rel: "src/demo.ts", abs: path.join(tmp, "src/demo.ts"), binary: false, before: "a\nb\n", after: "a\nc\n", kind: "modified" });
    await env.showDiffs!([d], "测试 diff");
    return "handled";
  });
  const ev = listen(ui);
  await request(ui, "POST", "/api/input", { body: { text: "/diff" } });
  const d = (await ev.waitFor((e) => e.t === "diff")) as Extract<UiEvent, { t: "diff" }>;
  assert.equal(d.files, 1);
  const page = await request(ui, "GET", `/diff/${d.id}`);
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /src\/demo\.ts/);
  assert.match(String(page.headers["content-security-policy"]), /sandbox/);
  assert.equal((await request(ui, "GET", "/diff/nope")).status, 404);
  assert.equal((await request(ui, "GET", `/diff/${d.id}`, { cookie: null })).status, 403);
  ev.close();
});

test("/file: media inside the project only, with Range support; no traversal, no non-media files, no symlink escape", async () => {
  const ui = await boot();
  const ok = await request(ui, "GET", "/file?p=a.png");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["content-type"], "image/png");
  assert.equal(ok.body.toString(), "0123456789abcdef");
  assert.equal(ok.headers["content-security-policy"], "sandbox");

  const part = await request(ui, "GET", "/file?p=a.png", { range: "bytes=2-5" });
  assert.equal(part.status, 206);
  assert.equal(part.body.toString(), "2345");
  assert.equal(part.headers["content-range"], "bytes 2-5/16");
  const tailR = await request(ui, "GET", "/file?p=a.png", { range: "bytes=-4" });
  assert.equal(tailR.body.toString(), "cdef");
  assert.equal((await request(ui, "GET", "/file?p=a.png", { range: "bytes=99-" })).status, 416);

  assert.equal((await request(ui, "GET", "/file?p=sub/v.mp4", { range: "bytes=0-9" })).status, 206);
  assert.equal((await request(ui, "GET", "/file?p=secret.txt")).status, 404, "not a media extension");
  assert.equal((await request(ui, "GET", "/file?p=.env")).status, 404);
  assert.equal((await request(ui, "GET", "/file?p=missing.png")).status, 404);
  assert.equal((await request(ui, "GET", `/file?p=${encodeURIComponent("../" + path.basename(outside) + "/leak.png")}`)).status, 404, "traversal");
  assert.equal((await request(ui, "GET", `/file?p=${encodeURIComponent(path.join(outside, "leak.png"))}`)).status, 404, "absolute path outside");
  assert.equal((await request(ui, "GET", "/file?p=a.png", { cookie: null })).status, 403);

  const link = path.join(tmp, "link.png");
  let linked = false;
  try { fs.symlinkSync(path.join(outside, "leak.png"), link); linked = true; } catch { /* Windows 没有权限创建符号链接：跳过这一项 */ }
  if (linked) assert.equal((await request(ui, "GET", "/file?p=link.png")).status, 404, "symlink escape");
});

test("/exit emits bye and notifies the launcher", async () => {
  const ui = await boot(async () => "exit");
  let bye = false;
  ui.onBye(() => { bye = true; });
  const ev = listen(ui);
  await request(ui, "POST", "/api/input", { body: { text: "/exit" } });
  await ev.waitFor((e) => e.t === "bye");
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(bye, true);
  ev.close();
});

test("captureConsole mirrors console output and restores it", () => {
  const seen: string[] = [];
  const restore = captureConsole((c) => seen.push(`${c.stream}:${c.text}`), { passthrough: false });
  console.log("a", { b: 1 });
  console.error("oops");
  console.log();
  restore();
  assert.deepEqual(seen, ["out:a { b: 1 }\n", "err:oops\n", "out:\n"]);
  const before = seen.length;
  console.log("after restore is not captured".slice(0, 0));   // 空串：不污染测试输出
  assert.equal(seen.length, before);
});

/* ---------------- 多对话 / 每对话的模型 / 图标 / 仓库列表 ---------------- */

const getJson = async (ui: UiServer, p: string) => JSON.parse((await request(ui, "GET", p)).body.toString());
const postJson = async (ui: UiServer, p: string, body: unknown) => { const r = await request(ui, "POST", p, { body }); return { status: r.status, body: r.body.length ? JSON.parse(r.body.toString()) : null }; };
const chatEv = (e: UiEvent) => (e as any).chat as string | undefined;

test("chats: each chat is its own session; new chat inherits repo and model; invalid directory is rejected", async () => {
  const ui = await boot();
  const [a] = ui.chats();
  assert.equal(a.cwd, path.resolve(tmp));
  assert.equal(a.title, "");
  const sub = path.join(tmp, "sub");
  const n1 = await postJson(ui, "/api/chat/new", { from: a.id });
  assert.equal(n1.status, 200);
  const n2 = await postJson(ui, "/api/chat/new", { cwd: sub, from: a.id });
  const list = (await getJson(ui, "/api/chats")) as { chats: any[]; repos: string[]; models: { id: string; backend: string }[] };
  assert.equal(list.chats.length, 3);
  const c1 = list.chats.find((c) => c.id === n1.body.id), c2 = list.chats.find((c) => c.id === n2.body.id);
  assert.equal(c1.cwd, a.cwd, "defaults to the source chat's repo");
  assert.equal(c1.model, a.model, "inherits the model");
  assert.equal(c2.cwd, path.resolve(sub));
  assert.ok(list.repos.includes(a.cwd) && list.repos.includes(path.resolve(sub)));
  assert.ok(list.models.some((m) => m.id === a.model));
  const bad = await postJson(ui, "/api/chat/new", { cwd: path.join(tmp, "nope") });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /不是有效目录/);
  assert.equal((await postJson(ui, "/api/input", { text: "x", chat: "deadbeef" })).status, 404);
  assert.equal((await request(ui, "POST", "/api/chat/new", { body: { cwd: sub }, origin: null })).status, 403);
});

test("chats run independently: concurrent tasks, per-chat busy, and console output lands in the chat that produced it", async () => {
  const gates = new Map<string, ReturnType<typeof gate>>();
  const ui = await boot(async (_s, _w, input) => {
    const g = gate(); gates.set(input, g);
    say(`start:${input}\n`);
    await new Promise((r) => setTimeout(r, 20));
    await g.p;
    say(`end:${input}\n`);
    return "handled";
  });
  const a = ui.chats()[0].id;
  const b = (await postJson(ui, "/api/chat/new", {})).body.id as string;
  const ev = listen(ui);
  assert.equal((await postJson(ui, "/api/input", { text: "one", chat: a })).status, 202);
  assert.equal((await postJson(ui, "/api/input", { text: "two", chat: b })).status, 202, "a different chat is not blocked by the first");
  assert.equal((await postJson(ui, "/api/input", { text: "again", chat: a })).status, 409, "the same chat still is");
  await ev.waitFor((e) => e.t === "out" && chatEv(e) === a && e.text.includes("start:one"));
  await ev.waitFor((e) => e.t === "out" && chatEv(e) === b && e.text.includes("start:two"));
  const info = (id: string) => ui.chats().find((c) => c.id === id)!;
  assert.deepEqual([info(a).busy, info(b).busy], [true, true]);
  gates.get("two")!.open();                                           // 后开始的先结束
  await ev.waitFor((e) => e.t === "out" && chatEv(e) === b && e.text.includes("end:two"));
  await ev.waitFor((e) => e.t === "busy" && chatEv(e) === b && e.busy === false);
  assert.deepEqual([info(a).busy, info(b).busy], [true, false]);
  gates.get("one")!.open();
  await ev.waitFor((e) => e.t === "out" && chatEv(e) === a && e.text.includes("end:one"));
  await ev.waitFor((e) => e.t === "busy" && chatEv(e) === a && e.busy === false);
  const text = (id: string) => ev.events.filter((e) => e.t === "out" && chatEv(e) === id).map((e: any) => e.text).join("");
  assert.equal(text(a).includes("two"), false, "chat A never sees chat B's output");
  assert.equal(text(b).includes("one"), false, "chat B never sees chat A's output");
  assert.ok(ev.events.some((e) => e.t === "chats"), "chat list updates are pushed");
  assert.equal(info(a).title, "one");                                  // 标题取自第一句话
  ev.close();
});

test("model is per chat: changing one chat leaves the others alone; not while that chat is busy", async () => {
  const g = gate();
  const ui = await boot(async () => { await g.p; return "handled"; });
  const a = ui.chats()[0].id;
  const b = (await postJson(ui, "/api/chat/new", { model: "model-b" })).body.id as string;
  const model = (id: string) => ui.chats().find((c) => c.id === id)!.model;
  assert.equal(model(b), "model-b");
  const before = model(a);
  assert.equal((await postJson(ui, "/api/chat/model", { chat: a, model: "model-a2" })).body.model, "model-a2");
  assert.deepEqual([model(a), model(b)], ["model-a2", "model-b"]);
  assert.equal(ui.ses.model, "model-a2", "the session's own model is what changed");
  assert.notEqual(before, "model-a2");
  assert.equal((await postJson(ui, "/api/chat/model", { chat: a, model: " " })).status, 400);
  assert.equal((await postJson(ui, "/api/chat/model", { chat: "nope", model: "x" })).status, 404);
  await postJson(ui, "/api/input", { text: "hold", chat: b });
  assert.equal((await postJson(ui, "/api/chat/model", { chat: b, model: "x" })).status, 409);
  const ev = listen(ui);
  g.open();
  await ev.waitFor((e) => e.t === "busy" && chatEv(e) === b && e.busy === false);
  ev.close();
});

test("interrupt and approval are scoped to one chat", async () => {
  const ui = await boot(async (ses, _w, input) => { await ses.prompter!.ask(`问 ${input}？ [Y]es / [n]o: `); return "handled"; });
  const a = ui.chats()[0].id;
  const b = (await postJson(ui, "/api/chat/new", {})).body.id as string;
  const ev = listen(ui);
  await postJson(ui, "/api/input", { text: "qa", chat: a });
  await postJson(ui, "/api/input", { text: "qb", chat: b });
  const askA = (await ev.waitFor((e) => e.t === "ask" && chatEv(e) === a)) as Extract<UiEvent, { t: "ask" }>;
  const askB = (await ev.waitFor((e) => e.t === "ask" && chatEv(e) === b)) as Extract<UiEvent, { t: "ask" }>;
  await postJson(ui, "/api/interrupt", { chat: a });
  await ev.waitFor((e) => e.t === "askdone" && e.id === askA.id);
  assert.equal(ev.events.some((e) => e.t === "askdone" && e.id === askB.id), false, "B's question is still waiting");
  assert.equal((await postJson(ui, "/api/answer", { id: askB.id, text: "y" })).status, 200);
  await ev.waitFor((e) => e.t === "busy" && chatEv(e) === b && e.busy === false);
  ev.close();
});

test("close chat / remove repo: sessions are disposed, the UI always keeps one chat, reconnect replays every chat", async () => {
  const ui = await boot(async (_s, _w, input) => { say(`said:${input}\n`); return "handled"; });
  const a = ui.chats()[0].id;
  const sub = path.join(tmp, "sub");
  const b = (await postJson(ui, "/api/chat/new", { cwd: sub })).body.id as string;
  const ev0 = listen(ui);
  await postJson(ui, "/api/input", { text: "hello-b", chat: b });
  await ev0.waitFor((e) => e.t === "busy" && chatEv(e) === b && e.busy === false);
  ev0.close();
  const late = listen(ui);                                            // 重连：每个对话各自回放
  await late.waitFor((e) => e.t === "out" && chatEv(e) === b && e.text.includes("said:hello-b"));
  assert.ok(late.events.some((e) => e.t === "state" && chatEv(e) === a), "every chat's state is replayed");
  assert.equal((await postJson(ui, "/api/chat/close", {})).status, 404, "closing must name a chat");
  assert.equal((await postJson(ui, "/api/chat/close", { chat: b })).status, 200);
  await late.waitFor((e) => e.t === "removed" && e.chat === b);
  assert.deepEqual(ui.chats().map((c) => c.id), [a]);
  // 关掉最后一个：自动补一个新对话，界面不会空
  assert.equal((await postJson(ui, "/api/chat/close", { chat: a })).status, 200);
  assert.equal(ui.chats().length, 1);
  assert.notEqual(ui.chats()[0].id, a);
  assert.equal(ui.chats()[0].cwd, path.resolve(tmp));
  late.close();

  // 移除仓库：连同其中的对话；至少保留一个
  const c = (await postJson(ui, "/api/chat/new", { cwd: sub })).body.id as string;
  assert.equal((await postJson(ui, "/api/repo/remove", { cwd: sub })).status, 200);
  assert.equal(ui.chats().some((x) => x.id === c), false);
  assert.equal((await getJson(ui, "/api/chats")).repos.includes(path.resolve(sub)), false);
  assert.equal((await postJson(ui, "/api/repo/remove", { cwd: path.resolve(tmp) })).status, 400);
});

test("/file serves from the requesting chat's repo", async () => {
  const ui = await boot();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "ma-web-other-"));
  try {
    fs.writeFileSync(path.join(other, "o.png"), "OTHER");
    const b = (await postJson(ui, "/api/chat/new", { cwd: other })).body.id as string;
    assert.equal((await request(ui, "GET", "/file?p=o.png")).status, 404, "first chat's repo has no o.png");
    const r = await request(ui, "GET", `/file?p=o.png&chat=${b}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), "OTHER");
    assert.equal((await request(ui, "GET", `/file?p=a.png&chat=${b}`)).status, 404);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test("repo list is remembered across restarts (dataDir) and forgets directories that no longer exist", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ma-web-data-"));
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), "ma-web-keep-"));
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), "ma-web-gone-"));
  try {
    const u1 = await startServer({ cwd: tmp, dataDir: data, captureConsole: false });
    servers.push(u1);
    await postJson(u1, "/api/chat/new", { cwd: keep });
    await postJson(u1, "/api/chat/new", { cwd: gone });
    fs.rmSync(gone, { recursive: true, force: true });
    await u1.close();
    const u2 = await startServer({ cwd: tmp, dataDir: data, captureConsole: false });
    servers.push(u2);
    const repos = (await getJson(u2, "/api/chats")).repos as string[];
    assert.ok(repos.includes(path.resolve(tmp)) && repos.includes(path.resolve(keep)));
    assert.equal(repos.includes(path.resolve(gone)), false);
    assert.equal(u2.chats().length, 1, "chats themselves start fresh; only the repo list is remembered");
  } finally { for (const d of [data, keep, gone]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("app icon: page declares one; built-in svg by default; a user-supplied icon.png wins; favicon.ico is the same image", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ma-web-icon-"));
  try {
    const ui = await startServer({ cwd: tmp, dataDir: data, captureConsole: false });
    servers.push(ui);
    assert.match((await request(ui, "GET", "/")).body.toString(), /<link rel="icon" href="\/app-icon">/);
    const def = await request(ui, "GET", "/app-icon");
    assert.equal(def.status, 200);
    assert.equal(def.headers["content-type"], "image/svg+xml");
    assert.match(def.body.toString(), /<svg/);
    assert.equal((await request(ui, "GET", "/app-icon", { cookie: null })).status, 403);

    const png = Buffer.from("89504e470d0a1a0a", "hex");
    fs.writeFileSync(path.join(data, "icon.png"), png);                 // 换图：不用重启，刷新窗口即可
    const mine = await request(ui, "GET", "/app-icon");
    assert.equal(mine.headers["content-type"], "image/png");
    assert.deepEqual(mine.body, png);
    assert.deepEqual((await request(ui, "GET", "/favicon.ico")).body, png);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("findCustomIcon: env var beats the app folder beats the data folder; junk and oversized files are ignored", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ma-icon-"));
  try {
    const exeDir = path.join(d, "app"), dataDir = path.join(d, "data");
    fs.mkdirSync(exeDir); fs.mkdirSync(dataDir);
    const exe = path.join(exeDir, "mini-agent-ui.exe");
    assert.equal(findCustomIcon(dataDir, {}, exe), null);
    fs.writeFileSync(path.join(dataDir, "icon.png"), "d");
    assert.equal(findCustomIcon(dataDir, {}, exe)?.file, path.join(dataDir, "icon.png"));
    fs.writeFileSync(path.join(exeDir, "icon.ico"), "e");
    assert.equal(findCustomIcon(dataDir, {}, exe)?.file, path.join(exeDir, "icon.ico"));
    assert.equal(findCustomIcon(dataDir, {}, path.join(exeDir, "node.exe"))?.file, path.join(dataDir, "icon.png"), "node's own folder is not the app folder");
    fs.writeFileSync(path.join(d, "mine.svg"), "<svg/>");
    assert.equal(findCustomIcon(dataDir, { AGENT_UI_ICON: path.join(d, "mine.svg") }, exe)?.type, "image/svg+xml");
    fs.writeFileSync(path.join(d, "notes.txt"), "x");
    assert.equal(findCustomIcon(null, { AGENT_UI_ICON: path.join(d, "notes.txt") }, path.join(d, "node.exe")), null, "not an image extension");
    fs.writeFileSync(path.join(dataDir, "icon.png"), Buffer.alloc(3 * 1024 * 1024));
    fs.rmSync(path.join(exeDir, "icon.ico"));
    assert.equal(findCustomIcon(dataDir, {}, exe), null, "oversized");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("deriveTitle: first real task becomes the title; plain commands do not", () => {
  assert.equal(deriveTitle("/pwd"), "");
  assert.equal(deriveTitle("/diff"), "");
  assert.equal(deriveTitle("/ask  这个项目怎么启动？"), "这个项目怎么启动？");
  assert.equal(deriveTitle("修复   登录\n报错"), "修复 登录 报错");
  assert.ok(deriveTitle("x".repeat(100)).length <= 30);
});

test("ReAct trace: streamed thought deltas are merged in the replay buffer; trace events are stamped and stay in their own chat", async () => {
  const ui = await boot(async () => {
    emitTrace({ kind: "thought", step: 1, id: "th1", text: "先看", append: true });
    emitTrace({ kind: "thought", step: 1, id: "th1", text: "一下", append: true });
    emitTrace({ kind: "thought", step: 1, id: "th1", text: "目录", append: true });
    emitTrace({ kind: "thought", step: 1, id: "th1", text: "", done: true });
    emitTrace({ kind: "action", step: 2, id: "c1", name: "read", text: '{"path":"a.ts"}' });
    emitTrace({ kind: "observation", step: 2, id: "c1", name: "read", text: "completed", ok: true });
  });
  const a = listen(ui);
  await a.waitFor((e) => e.t === "state");
  assert.equal((await request(ui, "POST", "/api/input", { body: { text: "go" } })).status, 202);
  await a.waitFor((e) => e.t === "busy" && e.busy === false);
  // 重新连接（刷新页面）：回放里只有一条合并后的思考
  const late = listen(ui);
  await late.waitFor((e) => e.t === "busy" && e.busy === false);
  const traces = late.events.filter((e) => e.t === "trace") as any[];
  const thoughts = traces.filter((e) => e.ev.kind === "thought");
  assert.equal(thoughts.length, 2, "one merged thought + its done marker, not one per fragment");
  assert.equal(thoughts[0].ev.text, "先看一下目录");
  assert.equal(thoughts[1].ev.done, true);
  assert.deepEqual(traces.map((e) => e.ev.kind), ["thought", "thought", "action", "observation"]);
  assert.ok(traces.every((e) => typeof e.ts === "number" && e.ts > 0), "every trace carries a timestamp");
  // 实时流不合并（客户端要的就是增量）
  assert.equal(a.events.filter((e) => e.t === "trace" && (e as any).ev.kind === "thought" && (e as any).ev.append).length, 3);
  a.close(); late.close();
});

/* ---------------- 关窗口后退出 ---------------- */
test("watchWindow: exits shortly after the last page disconnects; a quick reconnect (reload) does not exit; a connected page never exits", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const act = { clients: 1, everConnected: true, lastSeen: Date.now() };
  let exits = 0;
  const stop = watchWindow({ activity: () => act }, { graceMs: 120, pollMs: 10, onExit: () => exits++ });
  await sleep(250);
  assert.equal(exits, 0, "page connected");
  act.clients = 0; act.lastSeen = Date.now();                    // 刷新：断开……
  await sleep(50);
  act.clients = 1;                                               // ……很快重连
  await sleep(200);
  assert.equal(exits, 0, "reload within the grace period");
  act.clients = 0; act.lastSeen = Date.now();                    // 关窗口
  const t0 = Date.now();
  while (exits === 0 && Date.now() - t0 < 2000) await sleep(10);
  assert.equal(exits, 1);
  assert.ok(Date.now() - t0 < 600, `exit within ~grace, took ${Date.now() - t0}ms`);
  await sleep(100);
  assert.equal(exits, 1, "fires once");
  stop();
});

test("watchWindow: never connected -> exits only after startupMs (and not at all when 0); laptop sleep/wake is not mistaken for a closed window", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let exits = 0;
  const idle = { clients: 0, everConnected: false, lastSeen: Date.now() };
  const s1 = watchWindow({ activity: () => idle }, { graceMs: 30, pollMs: 10, startupMs: 0, onExit: () => exits++ });
  await sleep(150);
  assert.equal(exits, 0, "startupMs 0 = never give up on a window that was not launched by us");
  s1();
  const s2 = watchWindow({ activity: () => idle }, { graceMs: 30, pollMs: 10, startupMs: 100, onExit: () => exits++ });
  await sleep(300);
  assert.equal(exits, 1, "window never opened");
  s2();

  // 睡眠唤醒：时钟一下子跳了一分钟，页面还没来得及重连
  const realNow = Date.now; let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    let woke = 0;
    const act = { clients: 0, everConnected: true, lastSeen: Date.now() };
    const s3 = watchWindow({ activity: () => act }, { graceMs: 200, pollMs: 10, onExit: () => woke++ });
    await sleep(20);
    offset = 60_000;                                             // 睡了一分钟
    await sleep(80);
    assert.equal(woke, 0, "the wake-up moment counts as 'just seen'");
    act.clients = 1; act.lastSeen = Date.now();                  // 页面重连
    await sleep(300);
    assert.equal(woke, 0);
    s3();
  } finally { Date.now = realNow; }
});
