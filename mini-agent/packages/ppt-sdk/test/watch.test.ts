import { test } from "node:test";
import assert from "node:assert/strict";
import { PptWatcher, formatApplyResult, formatWatchEvent, type WatchIssuesEvent } from "../src/watch.js";
import { FakePpt, slide, textbox, sleep } from "./helpers.js";

const POLL = 15, DEBOUNCE = 60;

function setup(busy: () => boolean = () => false) {
  const ppt = new FakePpt();
  ppt.slides = [slide([textbox("ok", "fine", { left: 60, top: 60 })])];
  const w = new PptWatcher({ ppt, backupDir: "C:\\backups", pollMs: POLL, debounceMs: DEBOUNCE, busy, maxErrors: 3 });
  const events: WatchIssuesEvent[] = [];
  w.on("issues", (e) => events.push(e));
  return { ppt, w, events };
}

test("baseline is silent; a new problem is reported once after the debounce; fixing then re-breaking reports again", async (t) => {
  const { ppt, w, events } = setup();
  t.after(() => w.stop());
  w.start();
  await sleep(POLL * 6);
  assert.equal(events.length, 0, "no event for what was already there");

  ppt.current.shapes.push(textbox("tiny", "tiny", { size: 8, top: 200 }));
  ppt.version++;
  await sleep(DEBOUNCE / 2);
  assert.equal(events.length, 0, "debounced: the user may still be editing");
  await sleep(DEBOUNCE + POLL * 6);
  assert.equal(events.length, 1);
  assert.equal(events[0].fresh[0].rule, "small_font");
  assert.equal(events[0].slide, 1);

  await sleep(DEBOUNCE + POLL * 6);
  assert.equal(events.length, 1, "same problem is not repeated");

  // user fixes it (problem disappears), later breaks it again -> reported again
  ppt.current.shapes.find((s) => s.name === "tiny")!.size = 14; ppt.version++;
  await sleep(DEBOUNCE + POLL * 8);
  assert.equal(events.length, 1);
  ppt.current.shapes.find((s) => s.name === "tiny")!.size = 8; ppt.version++;
  await sleep(DEBOUNCE + POLL * 8);
  assert.equal(events.length, 2);
});

test("busy host: nothing is reported while busy; reported after it finishes", async (t) => {
  let busy = false;
  const { ppt, w, events } = setup(() => busy);
  t.after(() => w.stop());
  w.start();
  await sleep(POLL * 6);
  busy = true;
  ppt.current.shapes.push(textbox("tiny", "tiny", { size: 8, top: 200 })); ppt.version++;
  await sleep(DEBOUNCE + POLL * 8);
  assert.equal(events.length, 0);
  busy = false;
  await sleep(DEBOUNCE * 3 + POLL * 8);
  assert.equal(events.length, 1);
});

test("switching slides only re-baselines: the other slide's old problems are not 'new'", async (t) => {
  const { ppt, w, events } = setup();
  ppt.slides.push(slide([textbox("old-problem", "x", { size: 8 })], { index: 2 }));
  t.after(() => w.stop());
  w.start();
  await sleep(POLL * 6);
  ppt.activeSlide = 2; ppt.version++;
  await sleep(DEBOUNCE * 3 + POLL * 8);
  assert.equal(events.length, 0);
  assert.equal(w.issues.length > 0, true, "but the issues are known, so /apply can still use them");
});

test("apply(): all, by number, bad number, nothing to fix, clean", async () => {
  const { ppt, w } = setup();
  assert.deepEqual(await w.apply("1"), { status: "no_suggestions" });
  assert.deepEqual(await w.apply(""), { status: "clean" });

  ppt.current.shapes.push(
    textbox("tiny", "tiny", { size: 8, top: 200 }),
    textbox("faint", "faint", { color: "DDDDDD", top: 300 }),
    textbox("dense", "字".repeat(400), { top: 400, height: 100, textHeight: 50 }),     // needs human judgment
  );
  await w.checkNow();
  assert.deepEqual(await w.apply("99"), { status: "bad_number", total: w.issues.length });
  const dense = w.issues.findIndex((i) => i.rule === "dense_text") + 1;
  assert.deepEqual(await w.apply(String(dense)), { status: "no_fix", total: 1 });

  const r = await w.apply("");
  assert.equal(r.status, "applied");
  if (r.status !== "applied") return;
  assert.equal(r.ok, true);
  assert.equal(r.applied, 2);
  assert.equal(r.backup?.startsWith("C:\\backups"), true);
  assert.deepEqual(r.remaining.map((i) => i.rule), ["dense_text"], "only the human-judgment issue remains");
  assert.equal(ppt.backups.length, 1);
  const text = formatApplyResult(r);
  assert.match(text, /已执行 2 个修复操作/);
  assert.match(text, /仍有 1 个问题/);
  // a second apply does not re-backup the same presentation
  await w.apply("");
  assert.equal(ppt.backups.length, 1);
});

test("apply by number applies just that issue", async () => {
  const { ppt, w } = setup();
  ppt.current.shapes.push(textbox("tiny", "tiny", { size: 8, top: 200 }), textbox("faint", "faint", { color: "DDDDDD", top: 300 }));
  await w.checkNow();
  const contrast = w.issues.findIndex((i) => i.rule === "contrast") + 1;
  const r = await w.apply(String(contrast));
  assert.equal(r.status === "applied" && r.applied, 1);
  assert.equal(ppt.current.shapes.find((s) => s.name === "faint")!.color, "000000");
  assert.equal(ppt.current.shapes.find((s) => s.name === "tiny")!.size, 8, "the other issue was left alone");
});

test("repeated read failures stop the watcher and say so", async () => {
  const { ppt, w } = setup();
  const stopped: string[] = [];
  w.on("stopped", (r) => stopped.push(r));
  w.start();
  ppt.failFingerprint = true;
  await sleep(POLL * 12);
  assert.deepEqual(stopped, ["errors"]);
  assert.equal(w.running, false);
});

test("PowerPoint closed / nothing open is a quiet no-op", async (t) => {
  const { ppt, w, events } = setup();
  t.after(() => w.stop());
  ppt.running = false;
  w.start();
  await sleep(POLL * 6);
  assert.equal(events.length, 0);
  assert.equal(w.running, true);
  ppt.running = true; ppt.hasPresentation = false;
  await sleep(POLL * 6);
  assert.equal(events.length, 0);
});

test("formatWatchEvent mentions the slide, numbering and /apply", async () => {
  const { ppt, w } = setup();
  ppt.current.shapes.push(textbox("tiny", "tiny", { size: 8, top: 200 }));
  const all = await w.checkNow();
  const text = formatWatchEvent({ slide: 1, fresh: all, all });
  assert.match(text, /第 1 页\] 发现 1 个新问题/);
  assert.match(text, /\/apply/);
});
