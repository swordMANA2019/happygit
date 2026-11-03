#!/usr/bin/env python3
"""检查 .pptx 的常见版式问题：空白页、文字溢出、越界。用法: check_deck.py a.pptx [b.pptx ...]
退出码：0 = 通过；1 = 发现问题；127 = 环境缺 python-pptx（验证器不可用，不算代码问题）。"""
import math
import sys

try:
    from pptx import Presentation
    from pptx.util import Pt
except ImportError:
    print("[环境问题] 缺少 python-pptx，请先执行: python -m pip install python-pptx")
    sys.exit(127)

EMU_PER_IN = 914400
MAX_PARAGRAPHS = 9


def units(text):
    return sum(1.0 if ord(c) > 0x2E80 else 0.5 for c in text)


def needed_height_in(shape):
    """估算文本框需要的高度（英寸）。"""
    width_in = max(shape.width / EMU_PER_IN - 0.2, 0.5)
    total_pt = 0.0
    for p in shape.text_frame.paragraphs:
        text = "".join(r.text for r in p.runs)
        if not text:
            total_pt += 10
            continue
        size = max((r.font.size.pt for r in p.runs if r.font.size), default=18)
        per_line = max(1.0, width_in * 72 / size)
        lines = max(1, math.ceil(units(text) / per_line))
        total_pt += lines * size * 1.25 + size * 0.3
    return total_pt / 72


def check(path):
    problems = []
    prs = Presentation(path)
    sw, sh = prs.slide_width, prs.slide_height
    for idx, slide in enumerate(prs.slides, start=1):
        texts = 0
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                texts += 1
                if len(shape.text_frame.paragraphs) > MAX_PARAGRAPHS:
                    problems.append(f"第 {idx} 页：一个文本框有 {len(shape.text_frame.paragraphs)} 段，内容太多，建议拆页")
                need = needed_height_in(shape)
                have = shape.height / EMU_PER_IN
                if need > have * 1.08 and need > 0.6:
                    problems.append(f"第 {idx} 页：文字可能溢出文本框（需要约 {need:.1f}in，只有 {have:.1f}in）："
                                    f"「{shape.text_frame.text.strip()[:30]}…」")
            elif shape.shape_type == 13 or getattr(shape, "has_table", False):  # 图片或表格也算有内容
                texts += 1
            if shape.left is not None and shape.width is not None:
                if shape.left < -EMU_PER_IN * 0.05 or shape.top < -EMU_PER_IN * 0.05 \
                        or shape.left + shape.width > sw * 1.02 or shape.top + shape.height > sh * 1.02:
                    problems.append(f"第 {idx} 页：有元素超出幻灯片边界")
        if texts == 0:
            problems.append(f"第 {idx} 页：没有任何文字/表格/图片内容（空白页）")
    return len(prs.slides), problems


def main():
    paths = sys.argv[1:]
    if not paths:
        print(__doc__)
        return 2
    bad = False
    for path in paths:
        try:
            count, problems = check(path)
        except Exception as e:  # 文件损坏/不是 pptx
            print(f"[失败] {path}：无法打开（{e}）")
            bad = True
            continue
        if problems:
            bad = True
            print(f"[发现问题] {path}（{count} 页）")
            for p in problems:
                print(f"  - {p}")
        else:
            print(f"[通过] {path}：{count} 页，未发现空白页、溢出或越界")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
