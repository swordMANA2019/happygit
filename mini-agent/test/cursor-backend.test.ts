/**
 * Cursor 后端测试：用假的 @cursor/sdk（不联网、不需要 CURSOR_API_KEY）。
 * 运行：npm run test:agent
 * 注意：必须在导入 session/config 之前设置环境变量，所以下面用动态 import。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_BACKEND = "cursor";
process.env.OPENAI_API_KEY ??= "test-key";            // llm.ts 在导入时就会创建客户端
process.env.AGENT_CURSOR_MODEL = "Composer 2.5";
delete process.env.AGENT_CURSOR_SETTINGS;
delete process.env.AGENT_CURSOR_SANDBOX;
process.env.CURSOR_API_KEY = "cursor_test_key";

const { CursorBackend, READ_ONLY_TOOLS, briefArgs } = await import("../src/backends/cursor.js");
const { captureBaseline, recordChanges, TRACK_LIMITS } = await import("../src/backends/tracker.js");
const { pptCustomTools } = await import("../src/backends/cursor-ppt.js");
const { uiContext } = await import("../src/trace.js");
const { Workspace } = await import("../src/workspace.js");
const { Session } = await import("../src/session.js");
const { normalizeCursorModel, INITIAL_MODEL, BACKEND } = await import("../src/config.js");
const { FakePpt, slide, textbox } = await import("../packages/ppt-sdk/test/helpers.js");

const tmp = (p = "cursor-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (root: string, rel: string, text: string | Buffer) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const bump = () => new Promise((r) => setTimeout(r, 15));      // 让 mtime 一定变化

/* ---------------- 假 SDK ---------------- */
type Script = {
  events?: any[];
  /** 在流的中途对磁盘做点什么（模拟 Cursor Agent 改文件） */
  effect?: () => void | Promise<void>;
  result?: any;
  /** 流一直挂着直到 cancel() 被调用 */
  hang?: boolean;
  sendError?: Error;
  createError?: Error;
};
function fakeSdk(script: Script = {}) {
  const calls = { create: [] as any[], resume: [] as any[], send: [] as { prompt: string; opts: any }[], cancel: 0, close: 0 };
  let n = 0;
  const makeAgent = (id: string) => ({
    agentId: id,
    close() { calls.close++; },
    async send(prompt: string, opts: any) {
      if (script.sendError) throw script.sendError;
      calls.send.push({ prompt, opts });
      let release!: () => void;
      const cancelled = new Promise<void>((r) => { release = r; });
      let wasCancelled = false;
      return {
        id: "run-1",
        async *stream() {
          for (const e of script.events ?? []) yield e;
          if (script.effect) await script.effect();
          if (script.hang) await cancelled;
        },
        async wait() {
          if (script.hang) await cancelled;
          return wasCancelled ? { status: "cancelled" } : (script.result ?? { status: "finished", result: "ok" });
        },
        async cancel() { calls.cancel++; wasCancelled = true; release(); },
      };
    },
  });
  const sdk = {
    Agent: {
      async create(o: any) { if (script.createError) throw script.createError; calls.create.push(o); return makeAgent(`agent-${++n}`); },
      async resume(id: string, o: any) { calls.resume.push({ id, o }); return makeAgent(id); },
    },
  };
  return { sdk, calls, script };
}
const quiet = () => {};

/* ---------------- 配置 ---------------- */
test("config: cursor backend picks the model from AGENT_CURSOR_MODEL and normalizes display names", () => {
  assert.equal(BACKEND, "cursor");
  assert.equal(INITIAL_MODEL, "composer-2.5");
  assert.equal(normalizeCursorModel("  Composer 2.5 "), "composer-2.5");
  assert.equal(normalizeCursorModel("auto"), "auto");
});

test("briefArgs shows the most informative field", () => {
  assert.equal(briefArgs({ path: "src/a.ts", x: 1 }), "src/a.ts");
  assert.equal(briefArgs({ command: "npm  test\n--silent" }), "npm test --silent");
  assert.equal(briefArgs({ foo: 1 }), '{"foo":1}');
  assert.equal(briefArgs(undefined), "");
  assert.equal(briefArgs("x".repeat(300)).length, 100);
});

/* ---------------- 改动追踪 ---------------- */
test("tracker: added / modified / deleted files are journaled so rollback restores them exactly", async () => {
  const root = tmp();
  write(root, "keep.txt", "keep");
  write(root, "src/a.ts", "const a = 1;\n");
  write(root, "src/b.ts", "const b = 2;\n");
  write(root, "bin.dat", Buffer.from([0, 1, 2, 3, 255]));
  write(root, "node_modules/pkg/index.js", "ignored");
  const base = await captureBaseline(root, true);
  await bump();
  write(root, "src/a.ts", "const a = 100;\n");                  // 改
  fs.rmSync(path.join(root, "src/b.ts"));                       // 删
  write(root, "src/new/c.ts", "export {};\n");                  // 增
  write(root, "bin.dat", Buffer.from([9, 9, 9]));               // 二进制改
  write(root, "node_modules/pkg/index.js", "ignored but changed");   // 被忽略的目录：不统计

  const ws = new Workspace(root);
  const res = await recordChanges(base, ws);
  assert.equal(res.complete, true);
  assert.deepEqual(res.unrecoverable, []);
  assert.deepEqual(await ws.changedFiles(), ["bin.dat", "src/a.ts", "src/b.ts", "src/new/c.ts"]);
  const kinds = Object.fromEntries((await ws.changes()).map((c) => [c.rel, c.kind]));
  assert.deepEqual(kinds, { "bin.dat": "modified", "src/a.ts": "modified", "src/b.ts": "deleted", "src/new/c.ts": "added" });

  const restored = await ws.rollback();
  assert.equal(restored.length, 4);
  assert.equal(read(root, "src/a.ts"), "const a = 1;\n");
  assert.equal(read(root, "src/b.ts"), "const b = 2;\n");
  assert.ok(!fs.existsSync(path.join(root, "src/new/c.ts")), "added file removed");
  assert.deepEqual([...fs.readFileSync(path.join(root, "bin.dat"))], [0, 1, 2, 3, 255]);
  assert.equal(read(root, "node_modules/pkg/index.js"), "ignored but changed", "ignored dirs are never touched");
  assert.equal(read(root, "keep.txt"), "keep");
});

test("tracker: touching a file without changing content is not a change", async () => {
  const root = tmp();
  write(root, "a.txt", "same");
  const base = await captureBaseline(root, true);
  await bump();
  write(root, "a.txt", "same");
  const ws = new Workspace(root);
  await recordChanges(base, ws);
  assert.deepEqual(await ws.changedFiles(), []);
});

test("tracker: files too big to back up are reported as unrecoverable, not silently lost", async () => {
  const root = tmp();
  write(root, "big.bin", Buffer.alloc(TRACK_LIMITS.maxFileBytes + 10, 1));
  write(root, "small.txt", "s");
  const base = await captureBaseline(root, true);
  await bump();
  write(root, "big.bin", Buffer.alloc(TRACK_LIMITS.maxFileBytes + 20, 2));
  write(root, "small.txt", "t");
  const ws = new Workspace(root);
  const res = await recordChanges(base, ws);
  assert.deepEqual(res.unrecoverable, ["big.bin"]);
  assert.deepEqual(await ws.changedFiles(), ["small.txt"]);
});

test("tracker: stat-only baseline (ask mode) can detect new files (undoable) and flags modified ones as unrecoverable", async () => {
  const root = tmp();
  write(root, "a.txt", "a");
  const base = await captureBaseline(root, false);
  await bump();
  write(root, "a.txt", "changed");
  write(root, "new.txt", "n");
  const ws = new Workspace(root);
  const res = await recordChanges(base, ws);
  assert.deepEqual(res.unrecoverable, ["a.txt"]);
  assert.deepEqual(await ws.changedFiles(), ["new.txt"]);
});

/* ---------------- 后端：agent 生命周期 ---------------- */
test("backend: creates the agent with normalized model, cwd, project settings, API key; streams tool calls; returns the final answer", async () => {
  const root = tmp();
  const f = fakeSdk({
    events: [
      { type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } },
      { type: "tool_call", call_id: "c1", name: "read", status: "running", args: { path: "src/a.ts" } },
      { type: "tool_call", call_id: "c1", name: "read", status: "completed" },
      { type: "tool_call", call_id: "c2", name: "shell", status: "running", args: { command: "npm test" } },
      { type: "tool_call", call_id: "c2", name: "shell", status: "error" },
    ],
    result: { status: "finished", result: "  final answer  ", durationMs: 1234 },
  });
  const b = new CursorBackend({ sdk: f.sdk, apiKey: "k" });
  const logs: string[] = [];
  const t = await b.run({ root, model: "Composer 2.5", mode: "agent", prompt: "do it", log: (l) => logs.push(l) });
  assert.equal(t.status, "finished");
  assert.equal(t.text, "final answer");
  assert.equal(t.toolCalls, 2, "each call_id counted once");
  assert.equal(t.durationMs, 1234);
  assert.equal(f.calls.create.length, 1);
  const c = f.calls.create[0];
  assert.equal(c.apiKey, "k");
  assert.deepEqual(c.model, { id: "composer-2.5" });
  assert.equal(c.local.cwd, root);
  assert.deepEqual(c.local.settingSources, ["project"]);
  assert.equal(c.tools, undefined, "agent mode: full toolset");
  assert.deepEqual(f.calls.send[0].opts.model, { id: "composer-2.5" });
  assert.equal(f.calls.send[0].opts.local, undefined, "no custom tools unless provided");
  assert.ok(logs.some((l) => l.includes("▸ read src/a.ts")));
  assert.ok(logs.some((l) => l.includes("▸ shell npm test")));
  assert.ok(logs.some((l) => l.includes("✗ shell")));
  assert.equal(b.turns, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(root, ".agent", "cursor-agent.json"), "utf8"));
  assert.equal(saved.agentId, "agent-1");
});

test("backend: the same agent is reused; switching to ask mode resumes it (same id) with a read-only tool allowlist", async () => {
  const root = tmp();
  const f = fakeSdk();
  const b = new CursorBackend({ sdk: f.sdk, apiKey: "k" });
  await b.run({ root, model: "composer-2.5", mode: "agent", prompt: "1", log: quiet });
  await b.run({ root, model: "composer-2.5", mode: "agent", prompt: "2", log: quiet });
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.resume.length, 0);

  await b.run({ root, model: "composer-2.5", mode: "ask", prompt: "3", log: quiet });
  assert.equal(f.calls.create.length, 1, "no new conversation");
  assert.equal(f.calls.resume.length, 1);
  assert.equal(f.calls.resume[0].id, "agent-1");
  assert.deepEqual(f.calls.resume[0].o.tools, READ_ONLY_TOOLS);
  for (const w of ["edit", "shell", "delete", "applyAgentDiff", "task"]) assert.ok(!READ_ONLY_TOOLS.includes(w), `${w} must not be in the read-only set`);
  assert.equal(f.calls.close, 1, "old handle closed before resuming");

  await b.run({ root, model: "composer-2.5", mode: "agent", prompt: "4", log: quiet });
  assert.equal(f.calls.resume.length, 2);
  assert.equal(f.calls.resume[1].o.tools, undefined, "back to the full toolset");
});

test("backend: drop() starts a brand-new conversation; restore() resumes the saved one", async () => {
  const root = tmp();
  const f = fakeSdk();
  const b = new CursorBackend({ sdk: f.sdk, apiKey: "k" });
  await b.run({ root, model: "m", mode: "agent", prompt: "1", log: quiet });
  b.drop();
  assert.equal(b.turns, 0);
  await b.run({ root, model: "m", mode: "agent", prompt: "2", log: quiet });
  assert.equal(f.calls.create.length, 2);

  const f2 = fakeSdk();
  const b2 = new CursorBackend({ sdk: f2.sdk, apiKey: "k" });
  assert.equal(await b2.restore(root), true);
  await b2.run({ root, model: "m", mode: "agent", prompt: "3", log: quiet });
  assert.equal(f2.calls.create.length, 0);
  assert.equal(f2.calls.resume[0].id, "agent-2");
  assert.equal(await new CursorBackend({ sdk: f2.sdk }).restore(tmp()), false, "nothing to restore in a fresh dir");
});

test("backend: the ask-mode tool allowlist can be overridden by env (escape hatch if the SDK rejects a name)", async () => {
  const root = tmp();
  process.env.AGENT_CURSOR_ASK_TOOLS = "read, grep ,ls";
  try {
    const f = fakeSdk();
    await new CursorBackend({ sdk: f.sdk, apiKey: "k" }).run({ root, model: "m", mode: "ask", prompt: "x", log: quiet });
    assert.deepEqual(f.calls.create[0].tools, ["read", "grep", "ls"]);
  } finally { delete process.env.AGENT_CURSOR_ASK_TOOLS; }
});

test("backend: settings / sandbox env vars are passed through", async () => {
  const root = tmp();
  process.env.AGENT_CURSOR_SETTINGS = "none";
  process.env.AGENT_CURSOR_SANDBOX = "1";
  try {
    const f = fakeSdk();
    await new CursorBackend({ sdk: f.sdk, apiKey: "k" }).run({ root, model: "m", mode: "agent", prompt: "x", log: quiet });
    assert.deepEqual(f.calls.create[0].local.settingSources, []);
    assert.deepEqual(f.calls.create[0].local.sandboxOptions, { enabled: true });
  } finally {
    delete process.env.AGENT_CURSOR_SETTINGS;
    delete process.env.AGENT_CURSOR_SANDBOX;
  }
});

test("backend: Ctrl+C (abort signal) cancels the Cursor run and reports cancelled", async () => {
  const root = tmp();
  const f = fakeSdk({ hang: true });
  const b = new CursorBackend({ sdk: f.sdk, apiKey: "k" });
  const ac = new AbortController();
  const p = b.run({ root, model: "m", mode: "agent", prompt: "x", signal: ac.signal, log: quiet });
  setTimeout(() => ac.abort(), 60);
  const t = await p;
  assert.equal(t.status, "cancelled");
  assert.equal(f.calls.cancel, 1);

  const pre = new AbortController(); pre.abort();
  const t2 = await b.run({ root, model: "m", mode: "agent", prompt: "y", signal: pre.signal, log: quiet });
  assert.equal(t2.status, "cancelled");
  assert.equal(f.calls.send.length, 1, "an already-aborted turn never sends");
});

test("backend: startup / send failures are thrown with an actionable hint; run failures are returned", async () => {
  const root = tmp();
  const noKey = new CursorBackend({ sdk: fakeSdk({ createError: new Error("401 Unauthorized") }).sdk, apiKey: "" });
  noKey["apiKey"] = undefined;   // 构造函数会回退到环境变量，这里强制"没有 key"
  await assert.rejects(noKey.run({ root, model: "m", mode: "agent", prompt: "x", log: quiet }), /无法启动 Cursor Agent.*401.*没有设置 CURSOR_API_KEY/s);

  const badKey = new CursorBackend({ sdk: fakeSdk({ sendError: new Error("Invalid API key") }).sdk, apiKey: "k" });
  await assert.rejects(badKey.run({ root, model: "m", mode: "agent", prompt: "x", log: quiet }), /发送任务失败.*Invalid API key.*Admin API/s);

  const network = new CursorBackend({ sdk: fakeSdk({ sendError: new Error("ECONNRESET") }).sdk, apiKey: "k" });
  await assert.rejects(network.run({ root, model: "m", mode: "agent", prompt: "x", log: quiet }), (e: Error) => /ECONNRESET/.test(e.message) && !/Admin API/.test(e.message));

  const runErr = new CursorBackend({ sdk: fakeSdk({ result: { status: "error", error: { message: "model overloaded" } } }).sdk, apiKey: "k" });
  const t = await runErr.run({ root, model: "m", mode: "agent", prompt: "x", log: quiet });
  assert.equal(t.status, "error");
  assert.equal(t.error, "model overloaded");
});

test("muteSdkLogs: drops SDK INFO lines during a turn, keeps WARN/ERROR and normal output, and restores stdout afterwards", async () => {
  const { muteSdkLogs } = await import("../src/backends/cursor.js");
  const seen: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  (process.stdout as any).write = (c: any) => { seen.push(String(c)); return true; };
  (process.stderr as any).write = (c: any) => { seen.push(String(c)); return true; };
  const collector = process.stdout.write;
  try {
    await muteSdkLogs(async () => {
      process.stdout.write("12:43:53.108 INFO  Resolved the fallback encoding meta={}\n");
      process.stderr.write("12:43:53.667 DEBUG LocalCursorRulesService load completed\n12:43:53.668 INFO  second line\n");
      process.stderr.write("12:43:54.000 WARN  something fishy\n");
      process.stdout.write("[cursor] ▸ read a.ts\n");
      process.stdout.write("助手> 12:00:00.000 INFO appears inside normal prose\n");
      // 嵌套：内层结束不能提前恢复
      await muteSdkLogs(async () => { process.stdout.write("12:43:55.000 INFO  inner\n"); });
      process.stdout.write("12:43:56.000 INFO  after inner\n");
    });
    process.stdout.write("12:43:57.000 INFO  after the turn\n");
  } finally {
    (process.stdout as any).write = realOut;
    (process.stderr as any).write = realErr;
  }
  assert.deepEqual(seen, [
    "12:43:54.000 WARN  something fishy\n",
    "[cursor] ▸ read a.ts\n",
    "助手> 12:00:00.000 INFO appears inside normal prose\n",
    "12:43:57.000 INFO  after the turn\n",
  ]);
  assert.equal(process.stdout.write, realOut, "stdout.write restored");
  assert.notEqual(process.stdout.write, collector);
});

test("backend: a missing @cursor/sdk gives an install hint", async () => {
  const { loadCursorSdk } = await import("../src/backends/cursor.js");
  // 这个仓库里装了 SDK：只验证加载成功并带有 Agent.create / resume
  const sdk = await loadCursorSdk();
  assert.equal(typeof sdk.Agent.create, "function");
  assert.equal(typeof sdk.Agent.resume, "function");
});

/* ---------------- Session 集成 ---------------- */
function newSession(script: Script) {
  const root = tmp("cursor-ses-");
  const f = fakeSdk(script);
  const ses = new Session(root, INITIAL_MODEL, null);
  ses.cursorSdk = f.sdk as any;
  const origErr = console.error;
  console.error = () => {};                         // 吞掉 [cursor] 进度行
  return { root, f, ses, restore: () => { console.error = origErr; ses.dispose(); } };
}

test("session.fix: Cursor edits become changedFiles/diff/undo; status is 'unverified' with an honest warning; conversation file is not clobbered", async () => {
  const s = newSession({});
  try {
    write(s.root, "src/app.ts", "export const v = 1;\n");
    write(s.root, ".agent/conversation.json", "{\"keep\":true}");           // 原生后端留下的可恢复对话
    s.f.script.effect = async () => { await bump(); write(s.root, "src/app.ts", "export const v = 2;\n"); write(s.root, "src/extra.ts", "export {};\n"); };
    s.f.script.result = { status: "finished", result: "changed v to 2" };

    const res = await s.ses.fix("set v to 2");
    assert.equal(res.status, "unverified");
    assert.equal(res.answer, "changed v to 2");
    assert.deepEqual(res.changedFiles, ["src/app.ts", "src/extra.ts"]);
    assert.match(res.log, /Cursor Agent 完成.*没有参与/);
    assert.match(res.timing, /Cursor Agent composer-2\.5/);
    assert.equal(s.f.calls.create[0].model.id, "composer-2.5");
    assert.equal(s.f.calls.send[0].prompt, "set v to 2", "the task is passed through verbatim");

    assert.equal((await s.ses.lastDiffs())!.length, 2);
    const undone = await s.ses.undo();
    assert.deepEqual(undone, ["src/app.ts", "src/extra.ts"]);
    assert.equal(read(s.root, "src/app.ts"), "export const v = 1;\n");
    assert.ok(!fs.existsSync(path.join(s.root, "src/extra.ts")));
    assert.equal(read(s.root, ".agent/conversation.json"), "{\"keep\":true}");
    assert.equal(s.ses.turns, 1);
  } finally { s.restore(); }
});

test("session.fix: a pure Q&A turn is 'no_change' and carries the answer", async () => {
  const s = newSession({ result: { status: "finished", result: "It adds numbers." } });
  try {
    write(s.root, "a.ts", "x");
    const res = await s.ses.fix("what does a.ts do?");
    assert.equal(res.status, "no_change");
    assert.equal(res.answer, "It adds numbers.");
    assert.deepEqual(res.changedFiles, []);
    assert.equal(await s.ses.undo(), null, "nothing to undo after a Q&A turn");
  } finally { s.restore(); }
});

test("session.fix: Cursor run error → 'failed' but the edits made so far are kept and undoable", async () => {
  const s = newSession({});
  try {
    write(s.root, "a.ts", "old");
    s.f.script.effect = async () => { await bump(); write(s.root, "a.ts", "half-done"); };
    s.f.script.result = { status: "error", error: { message: "rate limited" } };
    const res = await s.ses.fix("edit a");
    assert.equal(res.status, "failed");
    assert.equal(res.rolledBack, false);
    assert.deepEqual(res.changedFiles, ["a.ts"]);
    assert.match(res.log, /rate limited/);
    await s.ses.undo();
    assert.equal(read(s.root, "a.ts"), "old");
  } finally { s.restore(); }
});

test("session.fix: interrupt() cancels the Cursor run → 'aborted'", async () => {
  const s = newSession({ hang: true });
  try {
    const p = s.ses.fix("long task");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(s.ses.interrupt(), true);
    const res = await p;
    assert.equal(res.status, "aborted");
    assert.equal(s.f.calls.cancel, 1);
    assert.equal(s.ses.busy, false);
  } finally { s.restore(); }
});

test("session.ask: read-only toolset; a violation is reported instead of hidden", async () => {
  const s = newSession({ result: { status: "finished", result: "answer" } });
  try {
    write(s.root, "a.ts", "x");
    const clean = await s.ses.ask("explain a.ts");
    assert.equal(clean.status, "done");
    assert.equal(clean.text, "answer");
    assert.deepEqual(s.f.calls.create[0].tools, READ_ONLY_TOOLS);

    s.f.script.effect = async () => { write(s.root, "oops.txt", "should not exist"); };
    const bad = await s.ses.ask("explain again");
    assert.match(bad.text, /只读模式下检测到文件变化.*oops\.txt/s);
    await s.ses.undo();
    assert.ok(!fs.existsSync(path.join(s.root, "oops.txt")), "the stray file can be removed with /undo");
  } finally { s.restore(); }
});

test("session.ask: a Cursor error is reported as llm_error text", async () => {
  const s = newSession({ result: { status: "error", error: { message: "boom" } } });
  try {
    const r = await s.ses.ask("q");
    assert.equal(r.status, "llm_error");
    assert.match(r.text, /Cursor 出错.*boom/);
  } finally { s.restore(); }
});

test("session.diagnose: read-only analysis; the report keeps the '## ' sections /diag expects", async () => {
  const s = newSession({ result: { status: "finished", result: "## Bug 1\nlocation...\n## Bug 2\nlocation..." } });
  try {
    const d = await s.ses.diagnose("why does login fail");
    assert.match(d.report, /^## Bug 1/);
    assert.match(s.f.calls.send[0].prompt, /只做只读诊断.*why does login fail/s);
    assert.deepEqual(s.f.calls.create[0].tools, READ_ONLY_TOOLS);
  } finally { s.restore(); }
});

test("session: /cd and /reset drop the Cursor conversation; /resume restores it; skills/mcp explain they're not used", async () => {
  const s = newSession({});
  try {
    await s.ses.fix("one");
    assert.equal(s.f.calls.create.length, 1);
    await s.ses.resetHistory();
    await s.ses.fix("two");
    assert.equal(s.f.calls.create.length, 2, "reset → new conversation");
    assert.equal(await s.ses.resume(), 1, "there is a saved Cursor agent for this directory");
    await s.ses.fix("three");
    assert.equal(s.f.calls.resume[0].id, "agent-2");

    const other = tmp("cursor-other-");
    s.ses.chdir(other);
    await s.ses.fix("four");
    assert.equal(s.f.calls.create.length, 3, "a different directory never shares the conversation");
    assert.equal(s.f.calls.create[2].local.cwd, other);
    assert.match(await s.ses.describeSkills(), /Cursor 后端/);
    assert.match(await s.ses.describeMcp(), /Cursor 后端/);
  } finally { s.restore(); }
});

test("session: a busy session rejects a second concurrent turn", async () => {
  const s = newSession({ hang: true });
  try {
    const p = s.ses.fix("a");
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(s.ses.fix("b"), /还在运行/);
    s.ses.interrupt();
    await p;
  } finally { s.restore(); }
});

/* ---------------- PowerPoint 自定义工具 ---------------- */
function pptCtx(mode: "agent" | "ask") {
  const ppt = new FakePpt();
  ppt.slides = [{ ...slide([textbox("t", "Hello")]) }];
  const root = tmp("cursor-ppt-");
  const ctx: any = { root, mode, ppt, extraRoots: new Set<string>(), pendingImages: [], task: "t", approved: new Set<string>(), askExternal: async () => false };
  return { ppt, ctx };
}

test("ppt custom tools: schemas come from the SDK; ask mode only exposes the read-only four", async () => {
  const { ctx } = pptCtx("agent");
  const all = pptCustomTools(() => ctx, { readOnly: false }) as Record<string, any>;
  assert.deepEqual(Object.keys(all).sort(), ["asset_search", "ppt_edit", "ppt_lint", "ppt_look", "ppt_open", "ppt_read", "ppt_save"]);
  for (const t of Object.values(all)) { assert.ok(t.description.length > 20); assert.equal(t.inputSchema.type, "object"); assert.equal(typeof t.execute, "function"); }
  const ro = pptCustomTools(() => ctx, { readOnly: true }) as Record<string, any>;
  assert.deepEqual(Object.keys(ro).sort(), ["asset_search", "ppt_lint", "ppt_look", "ppt_read"]);
});

test("ppt custom tools: execute goes through the same handlers (read, edit, ask-mode refusal)", async () => {
  const { ppt, ctx } = pptCtx("agent");
  const tools = pptCustomTools(() => ctx, { readOnly: false }) as Record<string, any>;
  const read = await tools.ppt_read.execute({}, {});
  assert.match(read, /演示文稿：/);
  const edit = await tools.ppt_edit.execute({ ops: [{ op: "add_textbox", name: "x", text: "hi", left: 60, top: 100, size: 20 }] }, {});
  assert.match(edit, /已应用 1 个操作/);
  assert.equal(ppt.edits.length, 1);

  const ask = pptCtx("ask");
  const askTools = pptCustomTools(() => ask.ctx, { readOnly: false }) as Record<string, any>;
  assert.match(await askTools.ppt_edit.execute({ ops: [{ op: "set_text" }] }, {}), /^\[已拒绝\]/, "even if exposed by mistake, ask-mode ctx still refuses writes");
  assert.equal(ask.ppt.edits.length, 0);
});

test("ppt custom tools: ppt_look returns the rendered slide as an image result for Cursor's own model (no vision model configured)", async () => {
  const { ctx } = pptCtx("agent");
  const tools = pptCustomTools(() => ctx, { readOnly: false }) as Record<string, any>;
  const r = await tools.ppt_look.execute({ question: "how does it look?" }, {});
  assert.equal(typeof r, "object");
  assert.equal(r.content[0].type, "text");
  const img = r.content.find((c: any) => c.type === "image");
  assert.ok(img, "image content present");
  assert.equal(img.mimeType, "image/png");
  assert.ok(!img.data.startsWith("data:"), "raw base64, not a data URL");
  assert.ok(Buffer.from(img.data, "base64").length > 0);
  assert.equal(ctx.pendingImages.length, 0, "queue drained");
});

test("backend: custom tools are attached to that send only when provided", async () => {
  const root = tmp();
  const f = fakeSdk();
  const b = new CursorBackend({ sdk: f.sdk, apiKey: "k" });
  const { ctx } = pptCtx("agent");
  await b.run({ root, model: "m", mode: "agent", prompt: "x", customTools: pptCustomTools(() => ctx, { readOnly: false }), log: quiet });
  await b.run({ root, model: "m", mode: "agent", prompt: "y", log: quiet });
  assert.ok(Object.keys(f.calls.send[0].opts.local.customTools).includes("ppt_edit"));
  assert.equal(f.calls.send[1].opts.local, undefined);
});

/* ---------------- 界面里的 ReAct 过程：流式思考 ---------------- */
test("ui trace: streamed thinking is ONE thought (same id, batched deltas, then done) followed by the tool row, not one record per fragment", async () => {
  const root = tmp();
  const words = "我 先 看 一下 目录 结构 再 决定 怎么 改".split(" ");
  const f = fakeSdk({
    events: [
      ...words.map((w) => ({ type: "thinking", text: w })),
      { type: "tool_call", call_id: "c1", name: "read", status: "running", args: { path: "src/a.ts" } },
      { type: "tool_call", call_id: "c1", name: "read", status: "completed" },
      { type: "thinking", text: "读完了" },
    ],
  });
  const b = new CursorBackend({ sdk: f.sdk, apiKey: "k" });
  const traces: any[] = [];
  await uiContext.run({ say: () => {}, trace: (e) => traces.push(e) }, () => b.run({ root, model: "composer-2.5", mode: "agent", prompt: "x" }));

  const first = traces.filter((t) => t.kind === "thought" && t.id === traces[0].id);
  assert.equal(first.map((t) => t.text).join(""), words.join(""), "all fragments arrive, in order, under one id");
  assert.ok(first.filter((t) => t.append).length <= 2, `fragments are batched (got ${first.length} events)`);
  assert.equal(first[first.length - 1].done, true);
  const kinds = traces.map((t) => t.kind + (t.done ? ":done" : ""));
  assert.ok(kinds.indexOf("thought:done") < kinds.indexOf("action"), "thought ends before the tool call starts");
  assert.ok(kinds.indexOf("action") < kinds.indexOf("observation"));
  const second = traces.filter((t) => t.kind === "thought" && t.id !== traces[0].id);
  assert.notEqual(second[0]?.id, undefined, "thinking after a tool call is a new thought");
  assert.equal(second[second.length - 1].done, true, "a thought still open when the stream ends is closed");
  const obs = traces.find((t) => t.kind === "observation");
  assert.equal(obs.id, "c1"); assert.equal(obs.ok, true);
});

test("ui trace: without a UI nothing is emitted and the terminal keeps its one-line progress", async () => {
  const root = tmp();
  const f = fakeSdk({ events: [{ type: "thinking", text: "hmm" }, { type: "tool_call", call_id: "c1", name: "read", status: "running", args: { path: "a" } }] });
  const logs: string[] = [];
  await new CursorBackend({ sdk: f.sdk, apiKey: "k" }).run({ root, model: "m", mode: "agent", prompt: "x", log: (l) => logs.push(l) });
  assert.ok(logs.some((l) => l.includes("▸ read a")));
});
