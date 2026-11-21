import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSlide, formatIssues, contrastRatio } from "../src/lint.js";
import { shape, slide, textbox } from "./helpers.js";

const rules = (s: ReturnType<typeof slide>, opts?: { minFont?: number }) => lintSlide(s, opts).map((i) => i.rule);

test("contrast ratio matches WCAG reference values", () => {
  assert.equal(Math.round(contrastRatio("000000", "FFFFFF")), 21);
  assert.equal(contrastRatio("FFFFFF", "FFFFFF"), 1);
  assert.ok(contrastRatio("767676", "FFFFFF") >= 4.5 && contrastRatio("777777", "FFFFFF") < 4.5);
});

test("a clean slide has no issues", () => {
  const s = slide([textbox("a", "Hello", { left: 60, top: 60 }), textbox("b", "World", { left: 60, top: 200 })]);
  assert.deepEqual(lintSlide(s), []);
  assert.match(formatIssues([]), /规则检查通过/);
});

test("off_slide: reports the side and offers a move-back fix", () => {
  const s = slide([textbox("wide", "x", { left: 800, top: 200, width: 300 })]);
  const [issue] = lintSlide(s).filter((i) => i.rule === "off_slide");
  assert.ok(issue, "expected off_slide");
  assert.equal(issue.severity, "error");
  assert.match(issue.message, /右/);
  const op = issue.fix!.ops[0] as any;
  assert.equal(op.op, "geometry");
  assert.equal(op.left, 660);              // 960 - 300
});

test("off_slide: full-bleed shapes (backgrounds) are allowed to bleed", () => {
  const s = slide([shape({ name: "bg", kind: "autoshape", left: -10, top: -10, width: 980, height: 560, fill: "123456" })]);
  assert.ok(!rules(s).includes("off_slide"));
});

test("off_slide: rotation is taken into account", () => {
  // 500x20 box near the top: unrotated it sits fully on the slide (230..730, 10..30)...
  const flat = slide([textbox("flat", "r", { left: 230, top: 10, width: 500, height: 20 })]);
  assert.ok(!rules(flat).includes("off_slide"));
  // ...but rotated 90deg it occupies 20x500 around the same centre (480,20) and spills off the top
  const rotated = slide([textbox("rot", "r", { left: 230, top: 10, width: 500, height: 20, rotation: 90 })]);
  assert.ok(rules(rotated).includes("off_slide"));
});

test("small_font: flags <12pt with a fix, not 12pt; minFont is configurable", () => {
  const small = slide([textbox("t", "tiny", { size: 8 })]);
  const issue = lintSlide(small).find((i) => i.rule === "small_font")!;
  assert.equal(issue.severity, "error");                       // <10pt
  assert.deepEqual((issue.fix!.ops[0] as any).size, 12);
  assert.ok(!rules(slide([textbox("t", "ok", { size: 12 })])).includes("small_font"));
  assert.ok(rules(slide([textbox("t", "ok", { size: 14 })]), { minFont: 16 }).includes("small_font"));
  // mixed font sizes come back from COM as a huge number: must be ignored
  assert.ok(!rules(slide([textbox("t", "mixed", { size: 9999999 })])).includes("small_font"));
});

test("contrast: uses own fill, then the shape underneath, then the slide background", () => {
  const onWhite = slide([textbox("faint", "x", { color: "DDDDDD" })]);
  const c1 = lintSlide(onWhite).find((i) => i.rule === "contrast")!;
  assert.ok(c1);
  assert.equal((c1.fix!.ops[0] as any).color, "000000");     // black has the better contrast on white

  const ownFill = slide([textbox("dark", "x", { color: "222222", fill: "111111" })]);
  const c2 = lintSlide(ownFill).find((i) => i.rule === "contrast")!;
  assert.ok(c2, "dark text on dark own fill");
  assert.equal((c2.fix!.ops[0] as any).color, "FFFFFF");

  const underneath = slide([
    shape({ name: "panel", kind: "autoshape", left: 0, top: 0, width: 960, height: 200, fill: "0B1F3A" }),
    textbox("onpanel", "x", { color: "222222", left: 100, top: 50 }),
  ]);
  assert.ok(lintSlide(underneath).some((i) => i.rule === "contrast" && i.shapes[0] === "onpanel"));

  const noBackground = slide([textbox("x", "x", { color: "DDDDDD" })], { background: undefined });
  assert.ok(!rules(noBackground).includes("contrast"), "unknown background: stay silent");
});

test("contrast: large text only needs 3:1", () => {
  // ratio of 777777 on white is ~4.48: fails for 18pt regular, passes for 28pt
  assert.ok(rules(slide([textbox("n", "x", { color: "777777", size: 18 })])).includes("contrast"));
  assert.ok(!rules(slide([textbox("n", "x", { color: "777777", size: 28 })])).includes("contrast"));
});

test("overflow: text taller than a fixed box, with grow-the-box fix; autosize boxes are exempt", () => {
  const s = slide([textbox("box", "long", { height: 40, textHeight: 120, autosize: 0 })]);
  const issue = lintSlide(s).find((i) => i.rule === "overflow")!;
  assert.ok(issue);
  assert.equal((issue.fix!.ops[0] as any).height, Math.round((120 + 2 * 3.6 + 2) * 10) / 10);
  assert.ok(!rules(slide([textbox("auto", "long", { height: 40, textHeight: 120, autosize: 1 })])).includes("overflow"));
  assert.ok(!rules(slide([textbox("shrink", "long", { height: 40, textHeight: 120, autosize: 2 })])).includes("overflow"));
});

test("overflow: no fix offered when growing would leave the slide", () => {
  const s = slide([textbox("low", "long", { top: 480, height: 40, textHeight: 120, autosize: 0 })]);
  const issue = lintSlide(s).find((i) => i.rule === "overflow")!;
  assert.ok(issue);
  assert.equal(issue.fix, undefined);
});

test("misaligned: 3pt apart is flagged and the minority moves; aligned or far apart is not", () => {
  const near = slide([textbox("a", "A", { left: 500, top: 300 }), textbox("b", "B", { left: 503, top: 360 }), textbox("c", "C", { left: 500, top: 420 })]);
  const issue = lintSlide(near).find((i) => i.rule === "misaligned")!;
  assert.ok(issue);
  assert.equal(issue.fix!.ops.length, 1);
  assert.equal((issue.fix!.ops[0] as any).left, 500);
  assert.equal(issue.fix!.ops.some((o: any) => o.shape === String(near.shapes[0].id)), false, "the majority does not move");

  const aligned = slide([textbox("a", "A", { left: 500, top: 300 }), textbox("b", "B", { left: 500, top: 360 })]);
  assert.ok(!rules(aligned).includes("misaligned"));
  const far = slide([textbox("a", "A", { left: 500, top: 300 }), textbox("b", "B", { left: 520, top: 360 })]);
  assert.ok(!rules(far).includes("misaligned"));
});

test("overlap: partial overlap is flagged; containment and slight touching are not", () => {
  const partial = slide([textbox("a", "A", { left: 100, top: 100, width: 200, height: 50 }), textbox("b", "B", { left: 200, top: 120, width: 200, height: 50 })]);
  assert.ok(rules(partial).includes("overlap"));
  const contained = slide([
    shape({ name: "card", kind: "autoshape", left: 90, top: 90, width: 400, height: 120, fill: "EEEEEE" }),
    textbox("label", "inside", { left: 100, top: 100, width: 200, height: 40 }),
  ]);
  assert.ok(!rules(contained).includes("overlap"), "text on a card is intentional");
  const touching = slide([textbox("a", "A", { left: 100, top: 100, width: 200, height: 50 }), textbox("b", "B", { left: 100, top: 148, width: 200, height: 50 })]);
  assert.ok(!rules(touching).includes("overlap"));
});

test("dense_text, empty_placeholder, fonts, no_alt, no_title", () => {
  const dense = slide([textbox("wall", "字".repeat(400), { height: 300, textHeight: 100 })]);
  assert.ok(rules(dense).includes("dense_text"));

  const empty = slide([shape({ name: "Title 1", kind: "placeholder", placeholder: 1 })]);
  const e = lintSlide(empty).find((i) => i.rule === "empty_placeholder")!;
  assert.equal((e.fix!.ops[0] as any).op, "delete_shape");
  // picture placeholders are not text placeholders
  assert.ok(!rules(slide([shape({ name: "Pic", kind: "placeholder", placeholder: 18 })])).includes("empty_placeholder"));

  const fonts = slide([textbox("a", "A", { font: "Arial", left: 10, top: 10 }), textbox("b", "B", { font: "Times New Roman", left: 300, top: 10 }), textbox("c", "C", { font: "Comic Sans MS", left: 600, top: 10 })]);
  assert.ok(rules(fonts).includes("fonts"));

  assert.ok(rules(slide([shape({ name: "photo", kind: "picture" })])).includes("no_alt"));
  assert.ok(!rules(slide([shape({ name: "photo", kind: "picture", alt: "a cat" })])).includes("no_alt"));

  assert.ok(rules(slide([textbox("a", "A")], { slideCount: 3 })).includes("no_title"));
  assert.ok(!rules(slide([textbox("a", "A")], { slideCount: 1 })).includes("no_title"));
});

test("issue ids are stable across runs and results are sorted by severity", () => {
  const build = () => slide([textbox("tiny", "x", { size: 8, left: 800, width: 300 }), textbox("faint", "y", { color: "EEEEEE", top: 300 })]);
  const a = lintSlide(build()), b = lintSlide(build());
  assert.equal(a.length > 0, true);
  // shape ids differ between builds, so compare rule + slide parts
  assert.deepEqual(a.map((i) => i.rule + i.slide), b.map((i) => i.rule + i.slide));
  const sev = a.map((i) => ({ error: 0, warn: 1, info: 2 }[i.severity]));
  assert.deepEqual(sev, [...sev].sort((x, y) => x - y));
  const s = build();
  assert.deepEqual(lintSlide(s).map((i) => i.id), lintSlide(s).map((i) => i.id));
});

test("hidden shapes are ignored", () => {
  const s = slide([textbox("ghost", "x", { size: 6, visible: false })]);
  assert.deepEqual(lintSlide(s), []);
});
