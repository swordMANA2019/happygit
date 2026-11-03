#!/usr/bin/env python3
"""根据 JSON 规格生成 .pptx。用法: build_deck.py spec.json out.pptx"""
import json
import math
import os
import sys

try:
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
    from pptx.util import Inches, Pt
except ImportError:
    print("[环境问题] 缺少 python-pptx，请先执行: python -m pip install python-pptx")
    sys.exit(127)

SLIDE_W, SLIDE_H = Inches(13.333), Inches(7.5)
MARGIN = Inches(0.7)


def rgb(hex_color):
    return RGBColor.from_string(hex_color.lstrip("#").upper())


def units(text):
    """估算字符宽度（以"半角字符=0.5em"为单位；CJK 全角=1em）。"""
    return sum(1.0 if ord(c) > 0x2E80 else 0.5 for c in text)


def lines_needed(text, size_pt, width_in):
    per_line = max(1.0, (width_in * 72) / size_pt)  # 每行可容纳的 em 数
    return max(1, math.ceil(units(text) / per_line))


def fit_size(paragraphs, width_in, height_in, base=24, minimum=12):
    """选一个能放下全部段落的最大字号。"""
    size = base
    while size > minimum:
        total = sum(lines_needed(p, size, width_in - 0.3) * size * 1.3 + size * 0.5 for p in paragraphs) / 72
        if total <= height_in - 0.2:
            break
        size -= 1
    return size


def add_text(slide, left, top, width, height, text, size, bold=False, color="222222", font="Calibri",
             align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.name = font
    run.font.color.rgb = rgb(color)
    return box


def flatten(items):
    """['a', ['b', 'c'], 'd'] -> [(0,'a'), (1,'b'), (1,'c'), (0,'d')]"""
    out = []
    for it in items or []:
        if isinstance(it, list):
            out.extend((1, str(x)) for x in it)
        else:
            out.append((0, str(it)))
    return out


def add_bullets(slide, items, left, top, width, height, theme):
    flat = flatten(items)
    size = fit_size([("    " if lv else "") + t for lv, t in flat], width / 914400, height / 914400)
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    for i, (level, text) in enumerate(flat):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(size * 0.4)
        run = p.add_run()
        run.text = ("      – " if level else "• ") + text
        run.font.size = Pt(size - (2 if level else 0))
        run.font.name = theme["font"]
        run.font.color.rgb = rgb("333333" if level == 0 else "555555")


def slide_title(slide, title, theme):
    bar = slide.shapes.add_shape(1, 0, 0, Inches(0.25), SLIDE_H)  # 左侧强调条
    bar.fill.solid()
    bar.fill.fore_color.rgb = rgb(theme["accent"])
    bar.line.fill.background()
    size = fit_size([title], 12.0, 1.1, base=32, minimum=20)
    add_text(slide, MARGIN, Inches(0.35), SLIDE_W - 2 * MARGIN, Inches(1.2), title, size, bold=True,
             color=theme["accent"], font=theme["font"], anchor=MSO_ANCHOR.MIDDLE)


def build_title(prs, spec, theme):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    bg = s.shapes.add_shape(1, 0, 0, SLIDE_W, SLIDE_H)
    bg.fill.solid()
    bg.fill.fore_color.rgb = rgb(theme["accent"])
    bg.line.fill.background()
    title = spec.get("title", "")
    add_text(s, Inches(1), Inches(2.3), SLIDE_W - Inches(2), Inches(1.8), title,
             fit_size([title], 11.3, 1.8, base=44, minimum=26), bold=True, color="FFFFFF",
             font=theme["font"], anchor=MSO_ANCHOR.MIDDLE)
    if spec.get("subtitle"):
        add_text(s, Inches(1), Inches(4.3), SLIDE_W - Inches(2), Inches(1), spec["subtitle"], 20,
                 color="DDDDDD", font=theme["font"])
    return s


def build_bullets(prs, spec, theme):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    slide_title(s, spec.get("title", ""), theme)
    add_bullets(s, spec.get("bullets", []), MARGIN, Inches(1.8), SLIDE_W - 2 * MARGIN, Inches(5.0), theme)
    return s


def build_two_column(prs, spec, theme):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    slide_title(s, spec.get("title", ""), theme)
    col_w = (SLIDE_W - 2 * MARGIN - Inches(0.5)) / 2
    add_bullets(s, spec.get("left", []), MARGIN, Inches(1.8), col_w, Inches(5.0), theme)
    add_bullets(s, spec.get("right", []), MARGIN + col_w + Inches(0.5), Inches(1.8), col_w, Inches(5.0), theme)
    return s


def build_table(prs, spec, theme):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    slide_title(s, spec.get("title", ""), theme)
    cols = spec.get("columns", [])
    rows = spec.get("rows", [])
    if not cols:
        return s
    height = Inches(min(5.0, 0.5 * (len(rows) + 1)))
    table = s.shapes.add_table(len(rows) + 1, len(cols), MARGIN, Inches(1.8), SLIDE_W - 2 * MARGIN, height).table
    for j, name in enumerate(cols):
        cell = table.cell(0, j)
        cell.text = str(name)
        cell.fill.solid()
        cell.fill.fore_color.rgb = rgb(theme["accent"])
        para = cell.text_frame.paragraphs[0]
        para.runs[0].font.size = Pt(16)
        para.runs[0].font.bold = True
        para.runs[0].font.color.rgb = rgb("FFFFFF")
    for i, row in enumerate(rows, start=1):
        for j, val in enumerate(row[: len(cols)]):
            cell = table.cell(i, j)
            cell.text = str(val)
            cell.text_frame.paragraphs[0].runs[0].font.size = Pt(14)
    return s


def build_image(prs, spec, theme):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    slide_title(s, spec.get("title", ""), theme)
    path = spec.get("image", "")
    if not os.path.exists(path):
        raise SystemExit(f"图片不存在: {path}")
    max_w, max_h = SLIDE_W - 2 * MARGIN, Inches(4.6)
    pic = s.shapes.add_picture(path, MARGIN, Inches(1.7), width=max_w)
    if pic.height > max_h:  # 太高就按高度等比缩小
        ratio = max_h / pic.height
        pic.width, pic.height = int(pic.width * ratio), int(max_h)
    pic.left = int((SLIDE_W - pic.width) / 2)
    if spec.get("caption"):
        add_text(s, MARGIN, Inches(6.5), SLIDE_W - 2 * MARGIN, Inches(0.5), spec["caption"], 14,
                 color="666666", font=theme["font"], align=PP_ALIGN.CENTER)
    return s


BUILDERS = {
    "title": build_title,
    "bullets": build_bullets,
    "two_column": build_two_column,
    "table": build_table,
    "image": build_image,
}


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    spec_path, out_path = sys.argv[1], sys.argv[2]
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)

    theme = {"font": "Calibri", "accent": "1F4E79"}
    theme.update(spec.get("theme", {}))

    prs = Presentation()
    prs.slide_width, prs.slide_height = SLIDE_W, SLIDE_H

    for i, sl in enumerate(spec.get("slides", []), start=1):
        layout = sl.get("layout", "bullets")
        if layout not in BUILDERS:
            raise SystemExit(f"第 {i} 页：未知 layout「{layout}」，可用：{', '.join(BUILDERS)}")
        slide = BUILDERS[layout](prs, sl, theme)
        if sl.get("notes"):
            slide.notes_slide.notes_text_frame.text = sl["notes"]
        if layout != "title":
            add_text(slide, SLIDE_W - Inches(1.2), SLIDE_H - Inches(0.55), Inches(0.8), Inches(0.4), str(i), 12,
                     color="999999", align=PP_ALIGN.RIGHT)

    prs.save(out_path)
    print(f"已生成 {out_path}（{len(prs.slides)} 页）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
