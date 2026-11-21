/**
 * 集成测试：需要 Windows + 桌面版 PowerPoint。会新建临时演示文稿（用完关闭、不保存），不会改动你已打开的文稿。
 * 运行：npm run test:integration -w @mini-agent/ppt-sdk
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PptBridge, pptAvailable } from "../src/bridge.js";
import { callPptTool, type PptHost } from "../src/tools.js";
import { lintSlide } from "../src/lint.js";
import { PptWatcher, type WatchIssuesEvent } from "../src/watch.js";
import { sleep } from "./helpers.js";

const skip = !pptAvailable() && "needs Windows + desktop PowerPoint";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-int-"));
const b = new PptBridge();
const host: PptHost = { ppt: b, root, scratchDir: path.join(root, "scratch"), backupDir: path.join(root, "backups") };
const call = async (name: string, args: any = {}) => (await callPptTool(host, name, args))!;
let opened = 0;

async function fresh() {
  await b.newPresentation(); opened++;
}
async function closeAll() {
  while (opened > 0) { try { await b.closeActive(); } catch { /* ignore */ } opened--; }
}
after(async () => { await closeAll(); b.dispose(); });

test("bridge: new presentation, edit batch (shapes, group), dump round-trip, theme", { skip }, async () => {
  await fresh();
  const st = await b.state();
  assert.equal(st.slideCount, 1);
  assert.equal(st.slideWidth, 960);
  const petals = [0, 60, 120, 180, 240, 300].map((r, i) => ({ op: "add_shape", shape: "oval", name: `petal${i}`, left: 440, top: 150, width: 80, height: 140, rotation: r, fill: "F48FB1" }));
  const r = await b.edit([
    { op: "add_textbox", slide: 1, text: "你好 PowerPoint", left: 60, top: 30, width: 500, height: 50, size: 32, bold: true, color: "1F4E79", name: "title-box" },
    ...petals,
    { op: "add_shape", shape: "circle", name: "center", left: 460, top: 190, width: 40, height: 40, fill: "FFD54F" },
    { op: "group", shapes: ["petal0", "petal1", "petal2", "petal3", "petal4", "petal5", "center"], name: "flower" },
    { op: "geometry", shape: "flower", left: 700, top: 300, width: 160, height: 160 },
  ]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.applied.length, 10);
  const d = await b.dump(1, true);
  assert.deepEqual(d.shapes.map((s) => s.name).sort(), ["flower", "title-box"]);
  const tb = d.shapes.find((s) => s.name === "title-box")!;
  assert.equal(tb.text, "你好 PowerPoint");
  assert.equal(tb.size, 32);
  assert.equal(tb.bold, true);
  assert.equal(tb.color, "1F4E79");
  assert.ok(d.theme?.colors?.accent1 && d.theme.majorFont);
  await closeAll();
});

test("bridge: lean dump (paragraphs from text, metrics only for fixed boxes), id/name lookup, prewarm", { skip }, async () => {
  await fresh();
  await b.edit([
    { op: "add_textbox", slide: 1, name: "auto", text: "one\rtwo\rthree", left: 40, top: 40, width: 300, height: 60 },
    { op: "add_textbox", slide: 1, name: "fixed", text: "x", left: 40, top: 200, width: 300, height: 60, autosize: false },
  ], false);
  const d = await b.dump(1);
  const auto = d.shapes.find((s) => s.name === "auto")!;
  const fixed = d.shapes.find((s) => s.name === "fixed")!;
  assert.equal(auto.paragraphs, 3);
  assert.equal(fixed.paragraphs, 1);
  assert.equal(fixed.textHeight !== undefined && fixed.marginT !== undefined, true, "fixed-size box keeps the overflow metrics");
  assert.equal(auto.textHeight, undefined, "auto-sized box skips the expensive layout reads");
  // lookup by numeric id (slow path) and by name (fast path) both resolve to the same shape
  const r = await b.edit([
    { op: "geometry", shape: String(fixed.id), left: 50 },
    { op: "geometry", shape: "fixed", top: 210 },
  ], false);
  assert.equal(r.ok, true, r.error);
  const moved = (await b.dump(1)).shapes.find((s) => s.name === "fixed")!;
  assert.deepEqual([moved.left, moved.top], [50, 210]);
  const miss = await b.edit([{ op: "geometry", shape: "no-such-shape", left: 1 }], false);
  assert.equal(miss.ok, false);
  assert.match(String(miss.error), /shape not found/);
  await b.prewarm();                                        // never throws, state unchanged
  assert.equal((await b.dump(1)).shapes.length, 2);
  await closeAll();
  const idle = new PptBridge();
  await idle.prewarm();                                     // fresh bridge, nothing open: resolves quietly
  idle.dispose();
});

test("bridge: fingerprint, export PNG, backup, failure reporting, slide ops", { skip }, async () => {
  await fresh();
  await b.edit([{ op: "add_textbox", slide: 1, name: "t", text: "a", left: 50, top: 50, width: 200, height: 40 }]);
  const f1 = await b.fingerprint(), f2 = await b.fingerprint();
  assert.equal(f1.fp, f2.fp);
  await b.edit([{ op: "set_text", shape: "t", text: "changed" }]);
  assert.notEqual((await b.fingerprint()).fp, f1.fp);

  const png = path.join(root, "slide.png");
  await b.exportSlide(1, png, 800);
  assert.equal(fs.readFileSync(png).subarray(1, 4).toString("latin1"), "PNG");   // 近乎空白的页压缩后很小，只检查文件头
  const bak = path.join(root, "bak.pptx");
  await b.backup(bak);
  assert.ok(fs.statSync(bak).size > 1000);

  const bad = await b.edit([{ op: "set_text", shape: "t", text: "x" }, { op: "set_text", shape: "no-such", text: "y" }, { op: "set_text", shape: "t", text: "z" }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.failedAt, 2);
  assert.equal(bad.applied.length, 1);
  assert.match(bad.error ?? "", /shape not found/);
  assert.equal((await b.dump(1)).shapes[0].text, "x", "ops after the failed one did not run");
  assert.match((await b.edit([{ op: "add_shape", shape: "nope" }])).error ?? "", /unknown shape/);

  const slides = await b.edit([
    { op: "add_slide", layout: "title_only" },
    { op: "duplicate_slide", slide: 2 },
    { op: "move_slide", slide: 3, to: 1 },
    { op: "set_notes", slide: 1, text: "备注" },
    { op: "delete_slide", slide: 1 },
  ]);
  assert.equal(slides.ok, true, slides.error);
  assert.equal((await b.titles()).slides.length, 2);
  await closeAll();
});

test("view follows edits: auto-jump to the changed slide, reveal=false stays, goto_slide, clamp after delete", { skip }, async () => {
  await fresh();
  await b.edit([{ op: "add_slide", layout: "blank" }, { op: "add_slide", layout: "blank" }, { op: "goto_slide", slide: 1 }], false);
  assert.equal((await b.state()).activeSlide, 1);
  const r = await b.edit([{ op: "add_textbox", slide: 3, text: "edited", left: 50, top: 50, width: 200, height: 40 }]);
  assert.equal(r.shown, 3);
  assert.equal((await b.state()).activeSlide, 3);
  await b.edit([{ op: "goto_slide", slide: 1 }], false);
  const failed = await b.edit([{ op: "set_text", slide: 2, shape: "ghost", text: "x" }]);
  assert.equal(failed.ok, false);
  assert.equal((await b.state()).activeSlide, 2, "a failed edit still shows the slide it was working on");
  await b.edit([{ op: "goto_slide", slide: 1 }], false);
  await b.edit([{ op: "add_textbox", slide: 2, text: "quiet", left: 50, top: 50, width: 200, height: 40 }], false);
  assert.equal((await b.state()).activeSlide, 1, "reveal=false leaves the view alone");
  await b.edit([{ op: "goto_slide", slide: 3 }]);
  const del = await b.edit([{ op: "delete_slide", slide: 3 }]);
  assert.equal(del.ok, true);
  const active = (await b.state()).activeSlide!;
  assert.ok(active >= 1 && active <= 2);
  await closeAll();
});

test("tools on real PowerPoint: flawed slide -> auto-lint -> fix, overflow, assets, picture, vision stub", { skip }, async () => {
  const assets = path.join(root, "assets");
  fs.mkdirSync(assets);
  const png = path.join(root, "flower.png");
  await fresh();
  await b.exportSlide(1, png, 400);                                   // 借一张真实 PNG 当素材
  fs.copyFileSync(png, path.join(assets, "pink_flower.png"));
  fs.writeFileSync(path.join(assets, "index.json"), JSON.stringify([{ file: "pink_flower.png", tags: ["flower", "花"], license: "CC0" }]));
  host.vision = async (req) => { assert.equal(req.png.subarray(1, 4).toString("latin1"), "PNG"); return "1. 标题偏小 → 放大"; };

  const edit = await call("ppt_edit", { ops: [
    { op: "add_textbox", name: "tiny", text: "tiny text", left: 60, top: 60, width: 300, height: 30, size: 8, color: "000000" },
    { op: "add_textbox", name: "faint", text: "faint gray", left: 60, top: 120, width: 400, height: 40, size: 24, color: "DDDDDD" },
    { op: "add_textbox", name: "wide", text: "hanging off the edge", left: 800, top: 200, width: 300, height: 40, size: 20, color: "222222" },
    { op: "add_textbox", name: "a", text: "A", left: 500, top: 300, width: 200, height: 30, size: 16, color: "222222" },
    { op: "add_textbox", name: "b", text: "B", left: 503, top: 360, width: 200, height: 30, size: 16, color: "222222" },
  ] });
  for (const rule of ["small_font", "contrast", "off_slide", "misaligned"]) assert.match(edit, new RegExp(`\\[${rule}\\]`), rule);
  assert.match(edit, /已在修改前备份/);
  assert.equal(fs.readdirSync(host.backupDir).length, 1);

  const fixed = await call("ppt_lint", { fix: true });
  assert.match(fixed, /已自动修复 4 个问题/);
  assert.match(fixed, /未发现问题|仅剩|\[提示\]/);

  // 溢出：固定大小的框
  await call("ppt_edit", { ops: [
    { op: "add_textbox", name: "box", text: "A long paragraph that cannot fit inside this tiny box. ".repeat(4), left: 60, top: 200, width: 200, height: 40, size: 18, color: "222222", wrap: true },
    { op: "format", shape: "box", autosize: false }, { op: "geometry", shape: "box", width: 200, height: 40 },
  ] });
  assert.ok(lintSlide(await b.dump()).some((i) => i.rule === "overflow"));
  await call("ppt_lint", { fix: true });
  assert.ok(!lintSlide(await b.dump()).some((i) => i.rule === "overflow"));

  // 素材 + 图片
  const found = await call("asset_search", { query: "花 flower" });
  assert.match(found, /pink_flower\.png/);
  const pic = await call("ppt_edit", { ops: [{ op: "add_picture", path: path.join(assets, "pink_flower.png"), left: 700, top: 20, width: 200, alt: "pink flower" }] });
  assert.match(pic, /added picture/);
  assert.match(await call("ppt_edit", { ops: [{ op: "add_picture", path: "C:/nope/flower.png" }] }), /图片不可用/);

  const read = await call("ppt_read");
  assert.match(read, /主题：/);
  assert.match(read, /'faint'/);
  assert.match(await call("ppt_look"), /标题偏小/);
  await closeAll();
});

test("watcher on real PowerPoint: baseline silent, new problem reported once, apply fixes it", { skip }, async (t) => {
  await fresh();
  const w = new PptWatcher({ ppt: b, backupDir: host.backupDir, pollMs: 300, debounceMs: 800 });
  const events: WatchIssuesEvent[] = [];
  w.on("issues", (e) => events.push(e));
  t.after(() => w.stop());
  w.start();
  await sleep(1500);
  assert.equal(events.length, 0);
  await b.edit([{ op: "add_textbox", slide: 1, name: "w1", text: "tiny watch text", left: 60, top: 60, width: 300, height: 30, size: 8, color: "000000" }]);
  await sleep(2500);
  assert.equal(events.length, 1);
  assert.equal(events[0].fresh[0].rule, "small_font");
  await sleep(1500);
  assert.equal(events.length, 1);
  const r = await w.apply("");
  assert.equal(r.status, "applied");
  assert.equal((await b.dump()).shapes.find((s) => s.name === "w1")!.size, 12);
  await closeAll();
});
