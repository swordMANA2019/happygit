import type { PptShape, PptSlide } from "./bridge.js";

/**
 * 幻灯片规则检查：纯 TS、确定性、不花 token。输入是 ppt-bridge 的 dump，输出问题列表。
 * 能机械修复的问题带 fix（一组 ppt_edit 操作），/apply 可以不经过模型直接执行。
 * 需要审美判断的（配色是否好看、层次是否清晰）不在这里——交给 ppt_look 让视觉模型看。
 */

export type Severity = "error" | "warn" | "info";
export type Issue = {
  /** 稳定 ID：同一问题多次 lint 保持一致，用于 watch 模式去重 */
  id: string;
  rule: string;
  severity: Severity;
  slide: number;
  shapes: string[];
  message: string;
  fix?: { desc: string; ops: Array<Record<string, unknown>> };
};

type Box = { l: number; t: number; r: number; b: number };

const TEXT_PLACEHOLDERS = new Set([1, 2, 3, 4]); // 标题 / 正文 / 居中标题 / 副标题
const r1 = (n: number) => Math.round(n * 10) / 10;

function bbox(s: PptShape): Box {
  const cx = s.left + s.width / 2, cy = s.top + s.height / 2;
  const a = ((s.rotation % 180) + 180) % 180;
  if (a === 0) return { l: s.left, t: s.top, r: s.left + s.width, b: s.top + s.height };
  const rad = (a * Math.PI) / 180;
  const w = Math.abs(s.width * Math.cos(rad)) + Math.abs(s.height * Math.sin(rad));
  const h = Math.abs(s.width * Math.sin(rad)) + Math.abs(s.height * Math.cos(rad));
  return { l: cx - w / 2, t: cy - h / 2, r: cx + w / 2, b: cy + h / 2 };
}
const area = (b: Box) => Math.max(0, b.r - b.l) * Math.max(0, b.b - b.t);
function inter(a: Box, b: Box): Box | null {
  const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bt = Math.min(a.b, b.b);
  return r > l && bt > t ? { l, t, r, b: bt } : null;
}

/* ---------- 对比度（WCAG 2.x） ---------- */
function lum(hex: string): number {
  const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrastRatio(a: string, b: string): number {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const isText = (s: PptShape) => !!s.text && s.text.trim().length > 0;
const isPic = (s: PptShape) => s.kind === "picture" || s.kind === "linked_picture";
const isContent = (s: PptShape) => s.visible && s.kind !== "line" && (isText(s) || isPic(s) || s.kind === "chart" || s.kind === "table" || s.kind === "smartart");
const ref = (s: PptShape) => `'${s.name}'`;
const idRef = (s: PptShape) => String(s.id);

export function lintSlide(sl: PptSlide, opts: { minFont?: number } = {}): Issue[] {
  const out: Issue[] = [];
  const W = sl.slideWidth, H = sl.slideHeight;
  const slideBox: Box = { l: 0, t: 0, r: W, b: H };
  const minFont = opts.minFont ?? 12;
  const shapes = sl.shapes.filter((s) => s.visible);
  const push = (rule: string, severity: Severity, ss: PptShape[], message: string, fix?: Issue["fix"]) =>
    out.push({ id: `${rule}|${sl.index}|${ss.map((s) => s.id).sort((a, b) => a - b).join(",")}`, rule, severity, slide: sl.index, shapes: ss.map((s) => s.name), message, fix });
  const fullBleed = (s: PptShape) => area(bbox(s)) >= 0.85 * W * H;

  /* 1. 出界 */
  for (const s of shapes) {
    if (fullBleed(s)) continue;                       // 背景图 / 全屏色块允许出血
    const b = bbox(s);
    const dl = Math.max(0, -b.l), dt = Math.max(0, -b.t), dr = Math.max(0, b.r - W), db = Math.max(0, b.b - H);
    if (Math.max(dl, dt, dr, db) < 2) continue;
    const sides = [dl > 1 && "左", dt > 1 && "上", dr > 1 && "右", db > 1 && "下"].filter(Boolean).join("/");
    const canFit = s.width <= W && s.height <= H && s.rotation % 180 === 0;
    const nl = Math.min(Math.max(s.left, 0), W - s.width), nt = Math.min(Math.max(s.top, 0), H - s.height);
    push("off_slide", "error", [s], `${ref(s)} 超出幻灯片${sides}边界（${r1(Math.max(dl, dt, dr, db))}pt）`,
      canFit ? { desc: `把 ${ref(s)} 移回幻灯片内`, ops: [{ op: "geometry", slide: sl.index, shape: idRef(s), left: r1(nl), top: r1(nt) }] } : undefined);
  }

  /* 2. 部分重叠（完全包含视为有意叠放：文字压在色块上等） */
  const content = shapes.filter(isContent);
  for (let i = 0; i < content.length; i++) for (let j = i + 1; j < content.length; j++) {
    const a = content[i], c = content[j];
    if (fullBleed(a) || fullBleed(c)) continue;
    const ia = inter(bbox(a), bbox(c));
    if (!ia) continue;
    const small = Math.min(area(bbox(a)), area(bbox(c)));
    if (small <= 0) continue;
    const frac = area(ia) / small;
    if (frac < 0.06 || frac > 0.9) continue;         // 轻微擦边忽略；>90% 认为是有意的包含
    push("overlap", frac > 0.3 ? "error" : "warn", [a, c], `${ref(a)} 与 ${ref(c)} 部分重叠（约占较小者的 ${Math.round(frac * 100)}%）`);
  }

  /* 3. 字号过小 */
  for (const s of shapes) {
    if (!isText(s) || !s.size || s.size <= 0 || s.size > 400) continue;   // 混合字号时 COM 会返回超大值
    if (s.size < minFont) {
      push("small_font", s.size < 10 ? "error" : "warn", [s], `${ref(s)} 字号 ${s.size}pt 偏小（投影建议 ≥${minFont}pt）`,
        { desc: `${ref(s)} 字号改为 ${minFont}pt`, ops: [{ op: "format", slide: sl.index, shape: idRef(s), size: minFont }] });
    }
  }

  /* 4. 文字对比度：背景取自身填充 → 下方包住它的填充形状 → 幻灯片背景 */
  for (const s of shapes) {
    if (!isText(s) || !s.color) continue;
    let bg = s.fill;
    if (!bg) {
      const cx = s.left + s.width / 2, cy = s.top + s.height / 2;
      const under = shapes.filter((u) => u.z < s.z && u.fill && u.id !== s.id)
        .filter((u) => cx >= u.left && cx <= u.left + u.width && cy >= u.top && cy <= u.top + u.height)
        .sort((x, y) => y.z - x.z)[0];
      bg = under?.fill ?? sl.background;
    }
    if (!bg) continue;                                // 背景是渐变/图片：无法静态判断，留给 ppt_look
    const ratio = contrastRatio(s.color, bg);
    const large = (s.size ?? 0) >= 24 || ((s.size ?? 0) >= 18.66 && !!s.bold);
    const need = large ? 3 : 4.5;
    if (ratio >= need) continue;
    const best = contrastRatio("000000", bg) >= contrastRatio("FFFFFF", bg) ? "000000" : "FFFFFF";
    push("contrast", ratio < 2 ? "error" : "warn", [s], `${ref(s)} 文字色 #${s.color} 在背景 #${bg} 上对比度仅 ${ratio.toFixed(1)}:1（需要 ≥${need}:1）`,
      { desc: `${ref(s)} 文字改为 #${best}`, ops: [{ op: "format", slide: sl.index, shape: idRef(s), color: best }] });
  }

  /* 5. 文字溢出框（自动缩放/自动调整高度的框不算） */
  for (const s of shapes) {
    if (!isText(s) || !s.textHeight || s.autosize === 1 || s.autosize === 2) continue;
    const mt = s.marginT ?? 3.6;
    const avail = s.height - 2 * mt;
    if (s.textHeight <= avail + 1.5) continue;
    const need = r1(s.textHeight + 2 * mt + 2);
    const fits = s.rotation % 180 === 0 && s.top + need <= H - 8;
    push("overflow", s.textHeight > avail * 1.25 ? "error" : "warn", [s],
      `${ref(s)} 文字高度 ${r1(s.textHeight)}pt 超过框内可用高度 ${r1(avail)}pt（文字溢出）`,
      fits ? { desc: `${ref(s)} 高度增至 ${need}pt`, ops: [{ op: "geometry", slide: sl.index, shape: idRef(s), height: need }] } : undefined);
  }

  /* 6. 文字过多 */
  for (const s of shapes) {
    if (!isText(s)) continue;
    const n = (s.text ?? "").replace(/\s+/g, "").length;
    if ((s.paragraphs ?? 1) > 7 || n > 350) {
      push("dense_text", "warn", [s], `${ref(s)} 文字过多（${s.paragraphs ?? 1} 段 / ${n} 字），建议拆分成多页或精简为要点`);
    }
  }
  const total = shapes.reduce((a, s) => a + (isText(s) ? (s.text ?? "").replace(/\s+/g, "").length : 0), 0);
  if (total > 700) push("dense_slide", "info", shapes.filter(isText), `整页文字共约 ${total} 字，偏多`);

  /* 7. 对齐：左边缘/上边缘“差一点点”对不齐（0.5~6pt） */
  const alignable = shapes.filter((s) => isContent(s) && !fullBleed(s) && s.rotation % 180 === 0 && s.width >= 20 && s.height >= 12);
  for (const axis of ["left", "top"] as const) {
    const vals = alignable.map((s) => ({ s, v: s[axis] })).sort((x, y) => x.v - y.v);
    let i = 0;
    while (i < vals.length) {
      let j = i;
      while (j + 1 < vals.length && vals[j + 1].v - vals[j].v <= 6) j++;
      const group = vals.slice(i, j + 1);
      i = j + 1;
      if (group.length < 2) continue;
      const spread = group[group.length - 1].v - group[0].v;
      if (spread < 0.5) continue;                     // 已经对齐
      const counts = new Map<number, number>();
      for (const g of group) counts.set(r1(g.v), (counts.get(r1(g.v)) ?? 0) + 1);
      const target = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
      const movers = group.filter((g) => Math.abs(g.v - target) >= 0.5);
      push("misaligned", "warn", group.map((g) => g.s),
        `${group.map((g) => ref(g.s)).join("、")} 的${axis === "left" ? "左" : "上"}边缘相差 ${r1(spread)}pt，看起来像是想对齐却没对齐`,
        { desc: `把 ${movers.map((m) => ref(m.s)).join("、")} 的${axis === "left" ? "左" : "上"}边缘对齐到 ${target}`,
          ops: movers.map((m) => ({ op: "geometry", slide: sl.index, shape: idRef(m.s), [axis]: target })) });
    }
  }

  /* 8. 贴边（在幻灯片内但离边缘太近） */
  const edge = Math.max(14, Math.min(W, H) * 0.035);
  for (const s of content) {
    if (fullBleed(s) || TEXT_PLACEHOLDERS.has(s.placeholder ?? -1)) continue;
    const b = bbox(s);
    if (inter(b, slideBox) && b.l >= -2 && b.t >= -2 && b.r <= W + 2 && b.b <= H + 2
      && (b.l < edge || b.t < edge || W - b.r < edge || H - b.b < edge) && isText(s)) {
      push("tight_margin", "info", [s], `${ref(s)} 离幻灯片边缘太近（< ${Math.round(edge)}pt），留白不足`);
    }
  }

  /* 9. 空占位符（放映时不显示，但编辑态很难看；通常该填或该删） */
  for (const s of shapes) {
    if (s.kind === "placeholder" && TEXT_PLACEHOLDERS.has(s.placeholder ?? -1) && !isText(s)) {
      push("empty_placeholder", "warn", [s], `${ref(s)} 是空的文字占位符`,
        { desc: `删除空占位符 ${ref(s)}`, ops: [{ op: "delete_shape", slide: sl.index, shape: idRef(s) }] });
    }
  }

  /* 10. 字体种类 */
  const fonts = new Set(shapes.filter(isText).map((s) => s.font).filter((f): f is string => !!f && !f.startsWith("+")));
  if (fonts.size > 2) push("fonts", "warn", shapes.filter(isText), `本页使用了 ${fonts.size} 种字体（${[...fonts].join("、")}），建议 ≤2 种`);

  /* 11. 图片无替代文字（无障碍） */
  for (const s of shapes) if (isPic(s) && !s.alt) push("no_alt", "info", [s], `图片 ${ref(s)} 没有替代文字`);

  /* 12. 无标题 */
  if (sl.slideCount > 1 && !shapes.some((s) => s.kind === "placeholder" && (s.placeholder === 1 || s.placeholder === 3))) {
    push("no_title", "info", [], `第 ${sl.index} 页没有标题占位符（大纲视图/无障碍导航里会显示为空）`);
  }

  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** 文本格式（给模型/控制台看）。每条问题带编号，/apply N 可以按编号执行 fix */
export function formatIssues(issues: Issue[], opts: { withFix?: boolean; startAt?: number } = {}): string {
  if (issues.length === 0) return "未发现问题（规则检查通过）。";
  const tag: Record<Severity, string> = { error: "错误", warn: "警告", info: "提示" };
  return issues.map((x, i) =>
    `${(opts.startAt ?? 1) + i}. [${tag[x.severity]}][${x.rule}] 第${x.slide}页：${x.message}${opts.withFix && x.fix ? `\n     可自动修复：${x.fix.desc}` : ""}`).join("\n");
}
