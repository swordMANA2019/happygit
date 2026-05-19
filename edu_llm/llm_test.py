"""
Test script for DataCleaner in common.py.

Features:
  - Load a subset of raw data (--sample-size, --seed) instead of the whole file
  - Report data quality metrics before and after cleaning
  - Visualise distributions with matplotlib

Usage examples:
  # Test with built-in synthetic samples (no dataset file needed)
  python llm_test.py

  # Test with a real JSON dataset, sampling 5000 rows
  python llm_test.py --data-file /path/to/wikipedia-zh-cn-20240820.json --sample-size 5000

  # Save the quality report charts to a directory
  python llm_test.py --data-file data.json --sample-size 2000 --plot-dir ./plots
"""

import argparse
import hashlib
import json
import os
import random
import re
import sys
from collections import Counter

# Ensure the console can handle Unicode (e.g. Chinese chars) on Windows.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

# ---------------------------------------------------------------------------
# Optional matplotlib – visualisation is skipped gracefully when absent
# ---------------------------------------------------------------------------
try:
    import matplotlib
    matplotlib.use("Agg")          # non-interactive backend – works in any env
    import matplotlib.pyplot as plt
    import matplotlib.ticker as mticker
    import numpy as np
    _HAVE_MPL = True
except ImportError:
    _HAVE_MPL = False
    print("[WARN] matplotlib / numpy not installed – visualisation disabled.\n"
          "       pip install matplotlib numpy")

# ---------------------------------------------------------------------------
# Project imports – add parent dir to path so the script is runnable from
# anywhere inside the repo.
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from common import (
    DataCleaner,
    MIN_TEXT_LENGTH,
    VALID_CHAR_THRESHOLD,
    NGRAM_REPEAT_LIMIT,
    is_valid_text,
    has_ngram_repeat,
)

# ===========================================================================
# Synthetic test corpus
# ===========================================================================
SYNTHETIC_SAMPLES: List[str] = [
    # --- should PASS ---
    "普勒蒂巴·帕尔克尔（，，），印度外交官，曾任、印度驻法兰克福总领事。\n经历.\n普勒蒂巴·帕尔克尔生于1972年7月17日，出身孟买。她毕业于孟买大学，拥有历史学硕士学位。\n2000年帕尔克尔加入印度外事服务部，开始了她的外交生涯。她于2002年至2006年在印度驻俄罗斯大使馆工作，并在莫斯科完成了语言培训，担任了两年新闻和文化二等秘书。2006年至2008年，她在新德里的印度外交部总部担任缅甸事务的副处长。",
    "黄桂华（,）是一位美国华人物理化学家。\n生平.\n1947年出生于英属香港，毕业于香港培道中学，1969年获得香港中文大学学士学位，1974年获得路易斯安那州立大学博士学位。1975年加入多伦多大学化学系担任助教，1981进入国际衍射数据中心担任研究员，1985年加入马里兰大学学院市分校担任教师，1988年加入国家标准技术研究所担任研究员。",
    "量子力学是物理学的一个基础分支，研究微观粒子（如电子、光子、原子）的行为规律。它由20世纪初的一系列实验发现催生，包括光电效应、黑体辐射和原子光谱等，这些现象无法用经典物理学解释。量子力学的核心概念包括波函数、叠加原理和测不准原理。",
    "人工智能（AI）是计算机科学的一个分支，致力于创建能够执行通常需要人类智能的任务的机器。这些任务包括学习、推理、问题解决、感知和语言理解。近年来，深度学习技术的突破使AI在图像识别、自然语言处理和游戏领域取得了显著进展。",
    # --- should FAIL: too short ---
    "短文本。",
    "OK",
    # --- should FAIL: URL noise ---
    "访问 https://www.example.com/some/very/long/path?query=123 获取更多信息。这段文字主要是URL。",
    # --- should FAIL: high n-gram repetition ---
    "哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈",
    # --- should FAIL: too much noise / special symbols ---
    "★★★☆☆☆▲▼◆◇▣▢⊙⊚⊛⊜⊝①②③④⑤⑥⑦⑧⑨⑩★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★",
    # --- should FAIL: no punctuation (pure noun list) ---
    "北京上海广州深圳成都武汉杭州南京重庆天津西安苏州宁波长沙郑州青岛大连厦门福州无锡合肥昆明哈尔滨济南佛山长春温州石家庄沈阳太原贵阳南宁海口乌鲁木齐兰州西宁呼和浩特银川拉萨台北高雄",
    # --- duplicate pair ---
    "机器学习是人工智能的一个子集，通过从数据中学习模式来做出预测和决策。它的核心思想是：让计算机从经验中学习，而无需显式编程。常见的机器学习算法包括线性回归、决策树、随机森林、支持向量机和神经网络。",
    "机器学习是人工智能的一个子集，通过从数据中学习模式来做出预测和决策。它的核心思想是：让计算机从经验中学习，而无需显式编程。常见的机器学习算法包括线性回归、决策树、随机森林、支持向量机和神经网络。",  # exact duplicate
    # --- empty brackets / stray punctuation ---
    "这篇文章（   ）介绍了自然语言处理的基础知识，包括分词、词性标注（,,,）、命名实体识别（）、句法分析和语义分析等核心任务。自然语言处理是计算机科学、人工智能和语言学交叉的领域，旨在使计算机能够理解、解释和生成人类语言。",
    # --- should PASS: English text with good quality ---
    "The Transformer architecture, introduced in 'Attention Is All You Need' (2017), revolutionised natural language processing. "
    "Unlike recurrent models, Transformers process all tokens in parallel using self-attention, dramatically reducing training time. "
    "Today, models like BERT, GPT and T5 are all built on the Transformer backbone, achieving state-of-the-art results across dozens of benchmarks.",
]


# ===========================================================================
# Diagnostics helpers
# ===========================================================================
@dataclass
class SampleDiagnostic:
    raw: str
    cleaned: Optional[str]
    reject_reason: str = ""

    # raw metrics
    raw_len: int = 0
    raw_noise_ratio: float = 0.0
    raw_ngram_dup_ratio: float = 0.0
    raw_punct_ratio: float = 0.0

    # cleaned metrics (only meaningful when cleaned is not None)
    clean_len: int = 0
    clean_noise_ratio: float = 0.0
    clean_ngram_dup_ratio: float = 0.0
    clean_punct_ratio: float = 0.0


_noise_re = re.compile(r"[^a-zA-Z0-9\s\u4e00-\u9fff.,!?;:'\"，。！？、；：''""（）]")
_punct_set = set(".,!?;:'\"，。！？、；：''""（）()")


def _metrics(text: str) -> Tuple[float, float, float]:
    """Return (noise_ratio, ngram_dup_ratio, punct_ratio) for a text."""
    if not text:
        return 0.0, 0.0, 0.0
    noise_ratio = len(_noise_re.findall(text)) / len(text)
    ngrams = [text[i:i + 2] for i in range(len(text) - 1)]
    if ngrams:
        cnt = Counter(ngrams)
        ngram_dup = cnt.most_common(1)[0][1] / len(ngrams)
    else:
        ngram_dup = 0.0
    punct_ratio = sum(1 for c in text if c in _punct_set) / len(text)
    return noise_ratio, ngram_dup, punct_ratio


def diagnose(raw: str, cleaner: DataCleaner) -> SampleDiagnostic:
    """Run the cleaner and collect before/after metrics."""
    diag = SampleDiagnostic(raw=raw, cleaned=None)
    diag.raw_len = len(raw)
    diag.raw_noise_ratio, diag.raw_ngram_dup_ratio, diag.raw_punct_ratio = _metrics(raw)

    # Replicate clean() steps individually to capture the rejection reason.
    basic = cleaner._basic_clean(raw)
    if not basic:
        diag.reject_reason = "empty_after_basic_clean"
        return diag

    if cleaner._is_duplicate(basic):
        diag.reject_reason = "duplicate"
        return diag

    if not cleaner._is_high_quality(basic):
        # Identify the specific sub-reason
        if len(basic) < MIN_TEXT_LENGTH:
            diag.reject_reason = "too_short"
        else:
            dup = cleaner._calc_ngram_dup_ratio(basic)
            if dup > 0.35:
                diag.reject_reason = "high_ngram_dup"
            else:
                noise = _noise_re.findall(basic)
                if len(noise) / len(basic) > 0.15:
                    diag.reject_reason = "high_noise"
                else:
                    diag.reject_reason = "low_punctuation"
        return diag

    diag.cleaned = basic
    diag.clean_len = len(basic)
    diag.clean_noise_ratio, diag.clean_ngram_dup_ratio, diag.clean_punct_ratio = _metrics(basic)
    return diag


# ===========================================================================
# Quality report
# ===========================================================================
def print_quality_report(diagnostics: List[SampleDiagnostic], label: str = ""):
    title = f"Data Quality Report{' – ' + label if label else ''}"
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")

    total = len(diagnostics)
    passed = [d for d in diagnostics if d.cleaned is not None]
    rejected = [d for d in diagnostics if d.cleaned is None]

    print(f"  Total samples      : {total}")
    print(f"  Passed (kept)      : {len(passed)}  ({len(passed)/total*100:.1f}%)")
    print(f"  Rejected (dropped) : {len(rejected)}  ({len(rejected)/total*100:.1f}%)")

    # Rejection breakdown
    if rejected:
        reasons: Counter = Counter(d.reject_reason for d in rejected)
        print("\n  Rejection reasons:")
        for reason, cnt in reasons.most_common():
            print(f"    {reason:<28} {cnt:>5}  ({cnt/total*100:.1f}%)")

    # Before / After metric comparison (on samples that passed)
    if passed:
        raw_lens   = [d.raw_len for d in passed]
        clean_lens = [d.clean_len for d in passed]
        raw_noise  = [d.raw_noise_ratio for d in passed]
        cln_noise  = [d.clean_noise_ratio for d in passed]
        raw_dup    = [d.raw_ngram_dup_ratio for d in passed]
        cln_dup    = [d.clean_ngram_dup_ratio for d in passed]
        raw_punct  = [d.raw_punct_ratio for d in passed]
        cln_punct  = [d.clean_punct_ratio for d in passed]

        def _fmt(vals):
            return f"mean={sum(vals)/len(vals):.4f}  min={min(vals):.4f}  max={max(vals):.4f}"

        print("\n  Passed-sample metrics (before -> after cleaning):")
        print(f"    Text length      : {_fmt(raw_lens)}")
        print(f"                   ->: {_fmt(clean_lens)}")
        print(f"    Noise ratio      : {_fmt(raw_noise)}")
        print(f"                   ->: {_fmt(cln_noise)}")
        print(f"    N-gram dup ratio : {_fmt(raw_dup)}")
        print(f"                   ->: {_fmt(cln_dup)}")
        print(f"    Punct ratio      : {_fmt(raw_punct)}")
        print(f"                   ->: {_fmt(cln_punct)}")

    print(f"{'=' * 60}\n")


# ===========================================================================
# Per-sample detail view
# ===========================================================================
def print_sample_details(diagnostics: List[SampleDiagnostic], max_show: int = 20):
    print(f"\n{'-' * 60}")
    print(f"  Per-sample detail  (showing up to {max_show})")
    print(f"{'-' * 60}")
    for i, d in enumerate(diagnostics[:max_show]):
        status = "PASS" if d.cleaned else f"FAIL[{d.reject_reason}]"
        preview = d.raw[:60].replace("\n", " ")
        print(f"  [{i+1:3d}] {status:<30} raw_len={d.raw_len:4d}  \"{preview}…\"")
    if len(diagnostics) > max_show:
        print(f"  ... {len(diagnostics) - max_show} more samples not shown ...")
    print()


# ===========================================================================
# Visualisation
# ===========================================================================
def visualise(diagnostics: List[SampleDiagnostic], plot_dir: Optional[str] = None):
    if not _HAVE_MPL:
        print("[WARN] Skipping visualisation (matplotlib not available).")
        return

    passed   = [d for d in diagnostics if d.cleaned is not None]
    rejected = [d for d in diagnostics if d.cleaned is None]

    fig, axes = plt.subplots(2, 3, figsize=(16, 9))
    fig.suptitle("DataCleaner – Quality Visualisation", fontsize=14, fontweight="bold")

    # ── 1. Pass / Fail pie ──────────────────────────────────────────────────
    ax = axes[0, 0]
    labels, sizes, colours = [], [], []
    if passed:
        labels.append(f"Passed\n({len(passed)})")
        sizes.append(len(passed))
        colours.append("#4CAF50")
    if rejected:
        labels.append(f"Rejected\n({len(rejected)})")
        sizes.append(len(rejected))
        colours.append("#F44336")
    ax.pie(sizes, labels=labels, colors=colours, autopct="%1.1f%%", startangle=90)
    ax.set_title("Pass / Reject ratio")

    # ── 2. Rejection reason bar ─────────────────────────────────────────────
    ax = axes[0, 1]
    if rejected:
        reasons = Counter(d.reject_reason for d in rejected)
        ax.barh(list(reasons.keys()), list(reasons.values()), color="#FF7043")
        ax.set_xlabel("Count")
        ax.set_title("Rejection reasons")
        ax.xaxis.set_major_locator(mticker.MaxNLocator(integer=True))
    else:
        ax.text(0.5, 0.5, "No rejected samples", ha="center", va="center")
        ax.set_title("Rejection reasons")

    # ── 3. Text length distribution (passed samples) ────────────────────────
    ax = axes[0, 2]
    if passed:
        raw_lens   = np.array([d.raw_len   for d in passed])
        clean_lens = np.array([d.clean_len for d in passed])
        bins = np.linspace(0, max(raw_lens.max(), clean_lens.max()) + 1, 30)
        ax.hist(raw_lens,   bins=bins, alpha=0.6, label="Before", color="#2196F3")
        ax.hist(clean_lens, bins=bins, alpha=0.6, label="After",  color="#4CAF50")
        ax.axvline(raw_lens.mean(),   color="#1565C0", linestyle="--", linewidth=1, label=f"Before mean={raw_lens.mean():.0f}")
        ax.axvline(clean_lens.mean(), color="#1B5E20", linestyle="--", linewidth=1, label=f"After  mean={clean_lens.mean():.0f}")
        ax.set_xlabel("Text length (chars)")
        ax.set_ylabel("Count")
        ax.set_title("Text length distribution")
        ax.legend(fontsize=8)
    else:
        ax.text(0.5, 0.5, "No passed samples", ha="center", va="center")
        ax.set_title("Text length distribution")

    # ── 4. Noise ratio (all raw samples) ────────────────────────────────────
    ax = axes[1, 0]
    all_noise = np.array([d.raw_noise_ratio for d in diagnostics])
    pass_noise = np.array([d.raw_noise_ratio for d in passed]) if passed else np.array([])
    rej_noise  = np.array([d.raw_noise_ratio for d in rejected]) if rejected else np.array([])
    bins = np.linspace(0, max(all_noise.max(), 0.01) + 0.01, 25)
    if len(pass_noise):
        ax.hist(pass_noise, bins=bins, alpha=0.6, label="Passed",   color="#4CAF50")
    if len(rej_noise):
        ax.hist(rej_noise,  bins=bins, alpha=0.6, label="Rejected", color="#F44336")
    ax.axvline(0.15, color="k", linestyle=":", linewidth=1.2, label="threshold=0.15")
    ax.set_xlabel("Noise character ratio")
    ax.set_ylabel("Count")
    ax.set_title("Noise ratio (raw text)")
    ax.legend(fontsize=8)

    # ── 5. N-gram duplicate ratio (all raw samples) ─────────────────────────
    ax = axes[1, 1]
    pass_dup = np.array([d.raw_ngram_dup_ratio for d in passed]) if passed else np.array([])
    rej_dup  = np.array([d.raw_ngram_dup_ratio for d in rejected]) if rejected else np.array([])
    all_dup  = np.concatenate([pass_dup, rej_dup]) if len(pass_dup) + len(rej_dup) else np.array([0])
    bins = np.linspace(0, max(all_dup.max(), 0.01) + 0.01, 25)
    if len(pass_dup):
        ax.hist(pass_dup, bins=bins, alpha=0.6, label="Passed",   color="#4CAF50")
    if len(rej_dup):
        ax.hist(rej_dup,  bins=bins, alpha=0.6, label="Rejected", color="#F44336")
    ax.axvline(0.35, color="k", linestyle=":", linewidth=1.2, label="threshold=0.35")
    ax.set_xlabel("2-gram duplicate ratio")
    ax.set_ylabel("Count")
    ax.set_title("N-gram repetition (raw text)")
    ax.legend(fontsize=8)

    # ── 6. Punctuation ratio (all raw samples) ──────────────────────────────
    ax = axes[1, 2]
    pass_punct = np.array([d.raw_punct_ratio for d in passed]) if passed else np.array([])
    rej_punct  = np.array([d.raw_punct_ratio for d in rejected]) if rejected else np.array([])
    all_punct  = np.concatenate([pass_punct, rej_punct]) if len(pass_punct) + len(rej_punct) else np.array([0])
    bins = np.linspace(0, max(all_punct.max(), 0.01) + 0.01, 25)
    if len(pass_punct):
        ax.hist(pass_punct, bins=bins, alpha=0.6, label="Passed",   color="#4CAF50")
    if len(rej_punct):
        ax.hist(rej_punct,  bins=bins, alpha=0.6, label="Rejected", color="#F44336")
    ax.axvline(0.02, color="k", linestyle=":", linewidth=1.2, label="threshold=0.02")
    ax.set_xlabel("Punctuation ratio")
    ax.set_ylabel("Count")
    ax.set_title("Punctuation density (raw text)")
    ax.legend(fontsize=8)

    plt.tight_layout()

    if plot_dir:
        os.makedirs(plot_dir, exist_ok=True)
        out_path = os.path.join(plot_dir, "datacleaner_quality.png")
        plt.savefig(out_path, dpi=150)
        print(f"[INFO] Chart saved → {out_path}")
    else:
        # Try to display; fall back to saving in cwd
        try:
            matplotlib.use("TkAgg")
            plt.show()
        except Exception:
            out_path = os.path.join(_HERE, "datacleaner_quality.png")
            plt.savefig(out_path, dpi=150)
            print(f"[INFO] Chart saved → {out_path}")

    plt.close(fig)


# ===========================================================================
# Data loading helpers
# ===========================================================================
def load_from_json(path: str, sample_size: int, seed: int) -> List[str]:
    """Stream-load a Wikipedia-style JSON file and return a random subset."""
    print(f"[INFO] Loading data from: {path}")
    all_texts: List[str] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                text = obj.get("text") or obj.get("content") or ""
                if text:
                    all_texts.append(text)
            except json.JSONDecodeError:
                continue

    print(f"[INFO] Total records in file: {len(all_texts)}")
    if sample_size and sample_size < len(all_texts):
        random.seed(seed)
        all_texts = random.sample(all_texts, sample_size)
        print(f"[INFO] Randomly sampled {sample_size} records (seed={seed})")
    return all_texts


def load_synthetic() -> List[str]:
    print("[INFO] No data file provided – using built-in synthetic samples.")
    return SYNTHETIC_SAMPLES


# ===========================================================================
# CLI
# ===========================================================================
def parse_args():
    parser = argparse.ArgumentParser(
        description="Test DataCleaner quality before/after cleaning with optional visualisation."
    )
    parser.add_argument(
        "--data-file", default=None,
        help="Path to raw JSON dataset (one JSON object per line with a 'text' field). "
             "Omit to use built-in synthetic samples.",
    )
    parser.add_argument(
        "--sample-size", type=int, default=0,
        help="Number of records to sample from the dataset (0 = all). Default: 0.",
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for sampling. Default: 42.",
    )
    parser.add_argument(
        "--plot-dir", default=None,
        help="Directory to save visualisation PNG. "
             "If omitted the chart is displayed interactively (or saved to the script directory).",
    )
    parser.add_argument(
        "--no-plot", action="store_true",
        help="Disable all visualisation.",
    )
    parser.add_argument(
        "--detail-rows", type=int, default=20,
        help="Number of per-sample detail rows to print. Default: 20.",
    )
    return parser.parse_args()


# ===========================================================================
# Main
# ===========================================================================
def main():
    args = parse_args()

    # ── Load data ──────────────────────────────────────────────────────────
    if args.data_file:
        texts = load_from_json(args.data_file, args.sample_size, args.seed)
    else:
        texts = load_synthetic()

    print(f"[INFO] Running DataCleaner on {len(texts)} sample(s)…\n")

    # ── Run cleaner with diagnostics ───────────────────────────────────────
    cleaner = DataCleaner()
    diagnostics: List[SampleDiagnostic] = [diagnose(t, cleaner) for t in texts]

    # ── Reports ───────────────────────────────────────────────────────────
    print_quality_report(diagnostics, label=args.data_file or "synthetic")
    print_sample_details(diagnostics, max_show=args.detail_rows)

    # ── Show a few cleaned texts ───────────────────────────────────────────
    passed = [d for d in diagnostics if d.cleaned]
    if passed:
        print(f"{'-' * 60}")
        print(f"  Sample cleaned texts (up to 3)")
        print(f"{'-' * 60}")
        for i, d in enumerate(passed[:3]):
            print(f"\n  [Cleaned #{i+1}]")
            print(f"  {d.cleaned[:300]}{'...' if len(d.cleaned) > 300 else ''}")
        print()

    # ── Visualisation ─────────────────────────────────────────────────────
    if not args.no_plot:
        visualise(diagnostics, plot_dir=args.plot_dir)
    else:
        print("[INFO] Visualisation disabled (--no-plot).")


if __name__ == "__main__":
    main()
