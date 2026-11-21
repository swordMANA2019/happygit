import fs from "node:fs";
import path from "node:path";
import type { EditResult, PptApi, PptFingerprint, PptShape, PptSlide, PptState } from "../src/bridge.js";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let nextId = 1;
export function shape(p: Partial<PptShape> & { name: string }): PptShape {
  return {
    id: nextId++, kind: "textbox", left: 100, top: 100, width: 200, height: 40, rotation: 0, z: 1, visible: true,
    ...p,
  } as PptShape;
}

export function slide(shapes: PptShape[], extra: Partial<PptSlide> = {}): PptSlide {
  shapes.forEach((s, i) => { s.z = i + 1; });
  return { index: 1, layout: "Blank", shapes, slideWidth: 960, slideHeight: 540, slideCount: 1, background: "FFFFFF", ...extra };
}

/** 一个有文字的框：默认 18pt 深灰字、白底 */
export function textbox(name: string, text: string, p: Partial<PptShape> = {}): PptShape {
  return shape({ name, text, paragraphs: 1, font: "Aptos", size: 18, bold: false, color: "222222", textHeight: 22, marginT: 3.6, autosize: 0, ...p });
}

/**
 * 内存里的假 PowerPoint：实现 PptApi，能“执行”少量编辑操作（format/geometry/delete_shape/add_textbox/set_text），
 * 足够测试工具层和 watcher 的行为，不需要装 PowerPoint。
 */
export class FakePpt implements PptApi {
  readonly backedUp = new Set<string>();
  running = true;
  hasPresentation = true;
  active = "Deck.pptx";
  presPath = "C:\\decks\\Deck.pptx";
  activeSlide = 1;
  selection: PptState["selection"] = { type: "none" };
  slides: PptSlide[] = [slide([])];
  /** fingerprint 变化：每次编辑 +1；测试也可以手动改 */
  version = 1;
  calls: string[] = [];
  edits: unknown[][] = [];
  backups: string[] = [];
  failAt: number | null = null;       // edit 在第几个操作失败（1-based）
  failFingerprint = false;
  saved: string[] = [];
  opened: string[] = [];

  get current(): PptSlide { return this.slides[this.activeSlide - 1]; }

  private need(): void {
    if (!this.running) throw new Error("NO_POWERPOINT: PowerPoint is not running");
    if (!this.hasPresentation) throw new Error("NO_PRESENTATION: no presentation is open in PowerPoint");
  }

  async state(): Promise<PptState> {
    this.calls.push("state");
    if (!this.running) return { running: false };
    if (!this.hasPresentation) return { running: true, presentations: [] };
    return {
      running: true, presentations: [{ name: this.active, path: this.presPath, saved: true, slides: this.slides.length }],
      active: this.active, path: this.presPath, saved: true, slideCount: this.slides.length,
      slideWidth: 960, slideHeight: 540, activeSlide: this.activeSlide, selection: this.selection,
    };
  }
  async dump(n?: number, theme = false): Promise<PptSlide> {
    this.calls.push(`dump:${n ?? "active"}`);
    this.need();
    const sl = this.slides[(n ?? this.activeSlide) - 1];
    if (!sl) throw new Error(`slide ${n} out of range`);
    const copy: PptSlide = { ...sl, slideCount: this.slides.length, shapes: sl.shapes.map((s) => ({ ...s })) };
    if (theme) copy.theme = { majorFont: "Aptos Display", minorFont: "Aptos", colors: { dark1: "000000", light1: "FFFFFF", accent1: "156082" } };
    return copy;
  }
  async titles() {
    this.need();
    return { slides: this.slides.map((s) => ({ index: s.index, title: s.shapes.find((x) => x.placeholder === 1)?.text ?? "", shapes: s.shapes.length })) };
  }
  async fingerprint(): Promise<PptFingerprint> {
    if (this.failFingerprint) throw new Error("call rejected by callee");
    if (!this.running) return { running: false };
    if (!this.hasPresentation) return { running: true, open: false };
    return { running: true, open: true, fp: `v${this.version}`, slide: this.activeSlide };
  }
  async exportSlide(n: number | undefined, file: string) {
    this.calls.push(`export:${n}`);
    this.need();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from("89504e470d0a1a0a", "hex"));   // PNG 魔数，够用
    return { path: file };
  }
  async edit(ops: unknown[], reveal = true): Promise<EditResult> {
    this.calls.push(`edit:${ops.length}:${reveal}`);
    this.need();
    this.edits.push(ops);
    const applied: string[] = [];
    for (const [i, raw] of ops.entries()) {
      const op = raw as any;
      if (this.failAt === i + 1) return { ok: false, applied, failedAt: i + 1, error: "shape not found: ghost" };
      const sl = this.slides[(op.slide ?? this.activeSlide) - 1] ?? this.current;
      const find = () => sl.shapes.find((s) => s.name === String(op.shape) || String(s.id) === String(op.shape));
      switch (op.op) {
        case "format": { const s = find(); if (s) { if (op.size !== undefined) s.size = op.size; if (op.color) s.color = op.color; } break; }
        case "geometry": { const s = find(); if (s) for (const k of ["left", "top", "width", "height", "rotation"] as const) if (op[k] !== undefined) (s as any)[k] = op[k]; break; }
        case "delete_shape": { const s = find(); if (s) sl.shapes.splice(sl.shapes.indexOf(s), 1); break; }
        case "add_textbox": sl.shapes.push(textbox(op.name ?? `tb${nextId}`, op.text ?? "", { left: op.left, top: op.top, width: op.width, height: op.height, size: op.size, color: op.color ?? "222222", z: sl.shapes.length + 1 })); break;
        case "set_text": { const s = find(); if (s) s.text = op.text; break; }
      }
      applied.push(`${op.op} ok`);
    }
    this.version++;
    return { ok: true, applied, shown: reveal ? (ops.length ? this.activeSlide : 0) : 0 };
  }
  async backup(file: string) { this.backups.push(file); return { path: file }; }
  async open(file: string) { this.opened.push(file); return { opened: path.basename(file) }; }
  async newPresentation() { this.hasPresentation = true; this.running = true; return { name: "Presentation9" }; }
  async save(file?: string) { this.saved.push(file ?? "(in place)"); return { saved: file ?? this.presPath }; }
}
