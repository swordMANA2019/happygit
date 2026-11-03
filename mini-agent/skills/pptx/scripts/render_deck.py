#!/usr/bin/env python3
"""把 .pptx 渲染成逐页 PNG，方便肉眼/视觉模型检查版式。用法: render_deck.py deck.pptx [输出目录]
依赖 LibreOffice（soffice）。PDF→PNG 优先用 PyMuPDF，其次 pdftoppm。
退出码：0 成功；127 缺少渲染环境（不是 deck 的问题）。"""
import glob
import os
import shutil
import subprocess
import sys


def find_soffice():
    for name in ("soffice", "libreoffice"):
        p = shutil.which(name)
        if p:
            return p
    for p in (r"C:\Program Files\LibreOffice\program\soffice.exe",
              r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
              "/Applications/LibreOffice.app/Contents/MacOS/soffice"):
        if os.path.exists(p):
            return p
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    deck = os.path.abspath(sys.argv[1])
    out_dir = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.splitext(deck)[0] + "_preview"
    os.makedirs(out_dir, exist_ok=True)

    soffice = find_soffice()
    if not soffice:
        print("[环境问题] 没找到 LibreOffice（soffice），无法渲染预览。可安装 LibreOffice，或跳过视觉检查并如实告知用户。")
        return 127
    r = subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", out_dir, deck],
                       capture_output=True, text=True, timeout=180)
    pdf = os.path.join(out_dir, os.path.splitext(os.path.basename(deck))[0] + ".pdf")
    if not os.path.exists(pdf):
        print(f"[失败] 转换 PDF 失败：{r.stderr.strip()[:300]}")
        return 1

    try:
        import fitz  # PyMuPDF
        doc = fitz.open(pdf)
        for i, page in enumerate(doc, start=1):
            page.get_pixmap(dpi=80).save(os.path.join(out_dir, f"slide-{i:02d}.png"))
    except ImportError:
        exe = shutil.which("pdftoppm")
        if not exe:
            print(f"[环境问题] 已生成 {pdf}，但缺少 PyMuPDF / pdftoppm，无法转成图片（pip install pymupdf）。")
            return 127
        subprocess.run([exe, "-png", "-r", "80", pdf, os.path.join(out_dir, "slide")], check=True)

    pngs = sorted(glob.glob(os.path.join(out_dir, "*.png")))
    print(f"已渲染 {len(pngs)} 页到 {out_dir}")
    for p in pngs:
        print("  " + p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
