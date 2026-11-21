import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callPptTool, PPT_TOOL_DEFS, PPT_TOOL_NAMES, PPT_READ_NAMES, PPT_WRITE_NAMES, type PptHost } from "../src/tools.js";
import { FakePpt, slide, textbox, shape } from "./helpers.js";

function setup(over: Partial<PptHost> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-tools-"));
  const ppt = new FakePpt();
  const host: PptHost = { ppt, root, scratchDir: path.join(root, "scratch"), backupDir: path.join(root, "backups"), ...over };
  const call = async (name: string, args: any = {}) => (await callPptTool(host, name, args))!;
  return { root, ppt, host, call };
}

test("tool definitions: names line up with the read/write split and have valid schemas", () => {
  const names = PPT_TOOL_DEFS.map((d) => d.function.name);
  assert.deepEqual([...names].sort(), [...PPT_TOOL_NAMES].sort());
  assert.deepEqual([...PPT_READ_NAMES, ...PPT_WRITE_NAMES].sort(), [...PPT_TOOL_NAMES].sort());
  for (const d of PPT_TOOL_DEFS) {
    assert.equal(d.type, "function");
    assert.ok(d.function.description.length > 20);
    assert.equal((d.function.parameters as any).type, "object");
  }
});

test("unknown tool names return undefined so the host can fall through", async () => {
  const { host } = setup();
  assert.equal(await callPptTool(host, "run_command", {}), undefined);
});

test("ppt_read: state, selection, outline, shapes and theme in one text", async () => {
  const { ppt, call } = setup();
  ppt.slides = [
    slide([shape({ name: "Title 1", kind: "placeholder", placeholder: 1, text: "Cats", paragraphs: 1, font: "Aptos Display", size: 40, color: "000000" }), textbox("body", "Cats are great")], { index: 1 }),
    slide([], { index: 2 }),
  ];
  ppt.selection = { type: "shapes", shapes: [{ id: ppt.slides[0].shapes[0].id, name: "Title 1" }] };
  const out = await call("ppt_read");
  assert.match(out, /演示文稿：Deck\.pptx/);
  assert.match(out, /共 2 页/);
  assert.match(out, /用户当前选中：形状 #\d+ 'Title 1'/);
  assert.match(out, /大纲：1\.Cats/);
  assert.match(out, /placeholder\(title\)/);
  assert.match(out, /主题：标题字体 Aptos Display/);
  assert.match(out, /accent1=#156082/);
});

test("ppt_read: guides the model when PowerPoint isn't running or nothing is open", async () => {
  const a = setup(); a.ppt.running = false;
  assert.match(await a.call("ppt_read"), /没有运行.*ppt_open/);
  const b = setup(); b.ppt.hasPresentation = false;
  assert.match(await b.call("ppt_read"), /没有打开的演示文稿.*ppt_open/);
});

test("ppt_edit: validates input before touching PowerPoint", async () => {
  const { ppt, call } = setup();
  assert.match(await call("ppt_edit", {}), /\[参数错误\]/);
  assert.match(await call("ppt_edit", { ops: [] }), /\[参数错误\]/);
  assert.match(await call("ppt_edit", { ops: [{ nope: 1 }] }), /ops\[0\].*op 字段/);
  assert.match(await call("ppt_edit", { ops: Array.from({ length: 41 }, () => ({ op: "set_text" })) }), /最多 40/);
  assert.equal(ppt.edits.length, 0);
});

test("ppt_edit: applies ops, backs up only before the first edit, appends lint, reports the revealed slide", async () => {
  const { ppt, call, root } = setup();
  const first = await call("ppt_edit", { ops: [{ op: "add_textbox", slide: 1, name: "tiny", text: "tiny", left: 60, top: 60, size: 8 }] });
  assert.match(first, /已应用 1 个操作/);
  assert.match(first, /已在修改前备份/);
  assert.match(first, /PowerPoint 窗口已自动切到第 1 页/);
  assert.match(first, /\[自动规则检查\].*small_font/s);
  assert.equal(ppt.backups.length, 1);
  assert.ok(ppt.backups[0].startsWith(path.join(root, "backups")));
  const second = await call("ppt_edit", { ops: [{ op: "set_text", shape: "tiny", text: "bigger now" }] });
  assert.doesNotMatch(second, /备份/);
  assert.equal(ppt.backups.length, 1);
});

test("ppt_edit: failure names the failing op and what was applied", async () => {
  const { ppt, call } = setup();
  ppt.failAt = 2;
  const out = await call("ppt_edit", { ops: [{ op: "add_textbox", name: "a", text: "a" }, { op: "set_text", shape: "ghost", text: "x" }, { op: "set_text", shape: "a", text: "z" }] });
  assert.match(out, /已应用 1 个操作（第 2 个失败/);
  assert.match(out, /\[操作失败\] 第 2 个操作（set_text）出错：shape not found: ghost/);
});

test("ppt_edit: add_picture goes through the host path resolver and extension check", async () => {
  const { root, ppt, call } = setup();
  assert.match(await call("ppt_edit", { ops: [{ op: "add_picture", path: "nope.png" }] }), /图片不可用.*asset_search/s);
  const txt = path.join(root, "a.txt"); fs.writeFileSync(txt, "x");
  assert.match(await call("ppt_edit", { ops: [{ op: "add_picture", path: "a.txt" }] }), /不是受支持的图片格式/);
  fs.writeFileSync(path.join(root, "ok.png"), "x");
  await call("ppt_edit", { ops: [{ op: "add_picture", path: "ok.png", left: 0, top: 0 }] });
  assert.equal((ppt.edits.at(-1)![0] as any).path, path.join(root, "ok.png"), "relative path resolved to absolute");
  assert.equal(ppt.edits.length, 1);

  // host-provided resolver (e.g. mini-agent's authorization) wins and can reject
  const h = setup({ resolvePath: async (p, kind) => (kind === "image" && p === "ok" ? { path: "C:\\assets\\ok.png" } : { error: "未授权" }) });
  await h.call("ppt_edit", { ops: [{ op: "add_picture", path: "ok" }] });
  assert.equal((h.ppt.edits[0][0] as any).path, "C:\\assets\\ok.png");
  assert.match(await h.call("ppt_edit", { ops: [{ op: "add_picture", path: "other.png" }] }), /未授权/);
});

test("read-only host refuses every mutating tool but still reads", async () => {
  const { ppt, call } = setup({ readOnly: true });
  for (const [name, args] of [["ppt_edit", { ops: [{ op: "set_text" }] }], ["ppt_open", {}], ["ppt_save", {}], ["ppt_lint", { fix: true }]] as const) {
    assert.match(await call(name, args), /^\[已拒绝\]/, name);
  }
  assert.equal(ppt.edits.length, 0);
  assert.match(await call("ppt_read"), /演示文稿：/);
  assert.match(await call("ppt_lint"), /规则检查/);
});

test("ppt_lint: reports, and fix=true repairs then re-lints", async () => {
  const { ppt, call } = setup();
  ppt.slides = [slide([textbox("tiny", "tiny", { size: 8 }), textbox("faint", "faint", { color: "DDDDDD", top: 300 })])];
  const before = await call("ppt_lint");
  assert.match(before, /small_font/);
  assert.match(before, /contrast/);
  assert.match(before, /可自动修复/);
  const fixed = await call("ppt_lint", { fix: true });
  assert.match(fixed, /已自动修复 2 个问题/);
  assert.match(fixed, /未发现问题/);
  assert.equal(ppt.current.shapes[0].size, 12);
  assert.equal(ppt.current.shapes[1].color, "000000");
  assert.match(await call("ppt_lint", { fix: true }), /没有可自动修复的问题/);
});

test("ppt_lint: all=true checks every slide", async () => {
  const { ppt, call } = setup();
  ppt.slides = [slide([textbox("ok", "fine")], { index: 1 }), slide([textbox("tiny", "tiny", { size: 8 })], { index: 2 })];
  const out = await call("ppt_lint", { all: true });
  assert.match(out, /全部幻灯片/);
  assert.match(out, /第2页/);
});

test("ppt_look: vision function receives the PNG and shape list; result is returned with the image path", async () => {
  let seen: any = null;
  const { ppt, call } = setup({ vision: async (req) => { seen = req; return "1. 标题偏小 → 放大到 40pt"; }, visionName: "my-vlm" });
  ppt.slides = [slide([textbox("t", "Hello")])];
  const out = await call("ppt_look", { question: "标题怎么样？" });
  assert.match(out, /视觉模型（my-vlm）对第 1 页的点评/);
  assert.match(out, /标题偏小/);
  assert.match(out, /渲染图：.*slide-1-\d+\.png/);
  assert.ok(Buffer.isBuffer(seen.png) && seen.png.length > 0);
  assert.match(seen.user, /'t' textbox/);
  assert.match(seen.user, /标题怎么样/);
  assert.match(seen.system, /设计师/);
});

test("ppt_look: vision errors and empty replies are reported, not thrown", async () => {
  const a = setup({ vision: async () => { throw new Error("rate limited"); } });
  assert.match(await a.call("ppt_look"), /调用视觉模型.*失败：rate limited/);
  const b = setup({ vision: async () => "   " });
  assert.match(await b.call("ppt_look"), /返回了空内容/);
});

test("ppt_look: falls back to attachImage, then to an explicit 'unavailable' with the host's hint", async () => {
  let attached: any = null;
  const a = setup({ attachImage: (i) => { attached = i; return true; } });
  assert.match(await a.call("ppt_look"), /图片会在下一条消息里提供给你/);
  assert.match(attached.dataUrl, /^data:image\/png;base64,/);
  const b = setup({ noVisionHint: "设置 X=1。" });
  const out = await b.call("ppt_look");
  assert.match(out, /不可用/);
  assert.match(out, /设置 X=1/);
});

test("ppt_open: new presentation, or open a file after path resolution; rejects non-presentations", async () => {
  const { root, ppt, call } = setup();
  assert.match(await call("ppt_open"), /已新建空白演示文稿 Presentation9/);
  assert.match(await call("ppt_open", { path: "missing.pptx" }), /无法打开/);
  fs.writeFileSync(path.join(root, "notes.txt"), "x");
  assert.match(await call("ppt_open", { path: "notes.txt" }), /不是演示文稿文件/);
  fs.writeFileSync(path.join(root, "deck.pptx"), "x");
  assert.match(await call("ppt_open", { path: "deck.pptx" }), /已打开 deck\.pptx/);
  assert.equal(ppt.opened[0], path.join(root, "deck.pptx"));
});

test("ppt_save: only .pptx, only inside the root unless saveRoot=null", async () => {
  const { root, ppt, call } = setup();
  assert.match(await call("ppt_save"), /已保存/);
  assert.equal(ppt.saved[0], "(in place)");
  assert.match(await call("ppt_save", { path: "..\\outside.pptx" }), /只能另存到项目目录内/);
  assert.match(await call("ppt_save", { path: "x.pdf" }), /以 \.pptx 结尾/);
  assert.match(await call("ppt_save", { path: "out\\deck.pptx" }), /已保存/);
  assert.equal(ppt.saved[1], path.join(root, "out", "deck.pptx"));
  const open = setup({ saveRoot: null });
  assert.match(await open.call("ppt_save", { path: path.join(os.tmpdir(), "elsewhere.pptx") }), /已保存/);
});

test("asset_search: finds assets, tells the host about the directories, and degrades gracefully", async () => {
  const { root, host, call } = setup();
  assert.match(await call("asset_search", {}), /需要 query/);
  assert.match(await call("asset_search", { query: "flower" }), /没有配置本地素材库/);
  const dir = path.join(root, "assets"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "rose_flower.png"), "x");
  let told: string[] = [];
  host.onAssetDirs = (d) => { told = d; };
  const hit = await call("asset_search", { query: "flower 花" });
  assert.match(hit, /rose_flower\.png/);
  assert.deepEqual(told, [dir]);
  assert.match(await call("asset_search", { query: "dinosaur" }), /没有匹配.*dinosaur/s);
});

test("bridge errors become guidance text, never exceptions", async () => {
  const { ppt, call } = setup();
  ppt.running = false;
  for (const name of ["ppt_read", "ppt_lint", "ppt_look"]) assert.match(await call(name), /ppt_open/, name);
  assert.match(await call("ppt_edit", { ops: [{ op: "set_text", shape: "a", text: "b" }] }), /\[PowerPoint\].*没有运行/s);
});
