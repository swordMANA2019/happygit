#!/usr/bin/env python3
"""
download_science.py
───────────────────
Downloads Chinese science-education articles and saves them into TOPIC-SPECIFIC
files, one topic per file, each capped at 20 MB:

    physics.json          ← 物理 (Physics)
    chemistry.json        ← 化学 (Chemistry)
    biology.json          ← 生物 (Biology)
    …
    physics.json.sha256   (SHA-256 sidecar, written when a file reaches 20 MB)

Topic-to-file mapping is fixed (see TOPICS below) so re-running always appends
to the correct file.  A state file (science_state.json) tracks the current
source and row position so no article is ever written twice.

Sources  (round-robin, all via hf-mirror.com, accessible in China)
───────
  1. wikimedia/wikipedia          20231101.zh  – Chinese Wikipedia (~1.3 M articles)
  2. allenai/c4                   zh           – C4 Chinese web corpus (Common Crawl)
  3. cc100                        zh-Hans-CN   – CC-100 Simplified Chinese web crawl
  4. BAAI/CCI3-HQ                 default      – BAAI curated high-quality Chinese corpus
  5. opencsg/chinese-fineweb-edu  default      – Web pages filtered for educational value

One-time setup
──────────────
    pip install datasets huggingface-hub requests

Usage
─────
    python download_science.py --output-dir C:/data
    python download_science.py --output-dir C:/data --articles 5000
    python download_science.py --output-dir C:/data --status
    python download_science.py --output-dir C:/data --verify
"""

import os
import sys

# ── Must be set BEFORE huggingface_hub / datasets are imported ────────────
os.environ["HF_ENDPOINT"]      = "https://hf-mirror.com"
os.environ["CURL_CA_BUNDLE"]   = ""
os.environ["REQUESTS_CA_BUNDLE"] = ""
os.environ["HF_HUB_CACHE"] = "/mnt/build/llm_data/huggingface/hub"
os.environ["HF_DATASETS_CACHE"] = "/mnt/build/llm_data/huggingface/datasets"
import ssl
ssl._create_default_https_context = ssl._create_unverified_context

try:
    import requests, urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    _orig_send = requests.Session.send
    def _send_no_verify(self, req, **kw):
        kw["verify"] = False
        return _orig_send(self, req, **kw)
    requests.Session.send = _send_no_verify
except ImportError:
    pass

import argparse
import hashlib
import json
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── Configuration ──────────────────────────────────────────────────────────
MAX_FILE_BYTES = 20 * 1024 * 1024   # 20 MB cap per topic file
STATE_FILE     = "science_state.json"
MIN_CHARS      = 200
OUTPUT_DIR     = "."
CACHE_DIR = "/mnt/build/llm_data"
# ── Data sources ────────────────────────────────────────────────────────────
# Sourced from datasets confirmed accessible via hf-mirror.com.
# "configs" : sub-config names to try (first success wins); None = no sub-config.
# "text_fields": field names to concatenate for article text (priority order).
# "note": human-readable description of the source.
SOURCES = [
    {
        "id":          "wikipedia_zh",
        "dataset":     "wikimedia/wikipedia",
        "configs":     ["20231101.zh", "20230601.zh", "20220301.zh"],
        "split":       "train",
        "text_fields": ["text"],
        "note":        "Chinese Wikipedia — ~1.3 M encyclopaedia articles",
    },
    # {
    #     # Common Crawl filtered by Google for clean web text; zh config is ~33 GB
    #     "id":          "c4_zh",
    #     "dataset":     "allenai/c4",
    #     "configs":     ["zh"],
    #     "split":       "train",
    #     "text_fields": ["text"],
    #     "note":        "C4 Chinese web corpus (Common Crawl, quality-filtered)",
    # },
    {
        # CC-100: deduplicated Common Crawl built for language-model pre-training
        "id":          "cc100_zh",
        "dataset":     "cc100",
        "configs":     ["zh-Hans-CN"],
        "split":       "train",
        "text_fields": ["text"],
        "note":        "CC-100 Simplified Chinese web crawl",
    },
    {
        # BAAI high-quality Chinese corpus (news, books, web, encyclopaedia)
        "id":          "cci3_hq",
        "dataset":     "BAAI/CCI3-HQ",
        "configs":     [None],
        "split":       "train",
        "text_fields": ["content", "text"],
        "note":        "BAAI CCI3-HQ — curated high-quality Chinese corpus",
    },
    {
        # Chinese educational web pages filtered for educational value (FineWeb-Edu style)
        "id":          "chinese_edu_web",
        "dataset":     "opencsg/chinese-fineweb-edu",
        "configs":     [None],
        "split":       "train",
        "text_fields": ["text", "content"],
        "note":        "Chinese FineWeb-Edu — web pages scored for educational quality",
    },
]

# ── Topic definitions ──────────────────────────────────────────────────────
# Each topic maps to one output file.  An article is classified into the FIRST
# topic whose keywords appear in the opening 600 characters.
# Order matters: more specific topics should come before broader ones.
TOPICS = [
    {
        "file":  "physics.json",
        "label": "Physics (物理)",
        "keywords": [
            "物理", "力学", "热力学", "电磁", "光学", "量子", "相对论",
            "核物理", "流体力学", "固体物理", "声学", "粒子物理",
            "牛顿", "爱因斯坦", "费曼", "薛定谔", "海森堡",
            "加速度", "动能", "势能", "动量", "引力", "电场", "磁场",
            "光速", "折射", "衍射", "干涉", "电磁波",
        ],
    },
    {
        "file":  "chemistry.json",
        "label": "Chemistry (化学)",
        "keywords": [
            "化学", "元素", "元素周期表", "化合物", "分子", "原子", "离子",
            "化学键", "氧化", "还原", "酸碱", "催化", "有机化学",
            "无机化学", "高分子", "溶液", "浓度", "摩尔",
            "居里", "门捷列夫", "拉瓦锡", "道尔顿",
            "蛋白质", "酶", "氨基酸", "核酸",
        ],
    },
    {
        "file":  "biology.json",
        "label": "Biology (生物)",
        "keywords": [
            "生物", "细胞", "基因", "DNA", "RNA", "染色体",
            "进化", "自然选择", "遗传", "生态", "光合作用", "呼吸作用",
            "细胞膜", "细胞核", "线粒体", "叶绿体", "核糖体",
            "达尔文", "孟德尔", "沃森", "克里克",
            "微生物", "细菌", "病毒", "真菌", "生态系统",
        ],
    },
    {
        "file":  "mathematics.json",
        "label": "Mathematics (数学)",
        "keywords": [
            "数学", "代数", "几何", "微积分", "统计学", "概率论", "数论",
            "拓扑", "线性代数", "微分方程", "函数", "极限", "导数", "积分",
            "勾股定理", "欧拉", "高斯", "黎曼", "费马",
            "矩阵", "向量", "行列式", "集合论",
        ],
    },
    {
        "file":  "astronomy.json",
        "label": "Astronomy (天文)",
        "keywords": [
            "天文", "宇宙", "星系", "恒星", "行星", "黑洞", "中子星",
            "太阳系", "银河系", "宇宙大爆炸", "暗物质", "暗能量", "红移",
            "哈勃", "开普勒", "哥白尼", "伽利略",
            "望远镜", "光年", "超新星", "白矮星",
        ],
    },
    {
        "file":  "earth_science.json",
        "label": "Earth Science (地球科学)",
        "keywords": [
            "地质", "地球", "地震", "火山", "板块", "矿物", "岩石", "化石",
            "气象", "气候", "大气", "海洋", "洋流", "潮汐",
            "地壳", "地幔", "地核", "地形",
        ],
    },
    {
        "file":  "computer_science.json",
        "label": "Computer Science (计算机科学)",
        "keywords": [
            "计算机", "算法", "数据结构", "人工智能", "机器学习", "神经网络",
            "操作系统", "编译器", "数据库", "网络协议", "密码学",
            "图灵", "冯·诺依曼", "香农", "半导体", "芯片",
            "深度学习", "大语言模型",
        ],
    },
    {
        "file":  "medicine.json",
        "label": "Medicine (医学)",
        "keywords": [
            "医学", "解剖", "生理", "免疫", "药理", "神经科学",
            "基因组", "细胞生物学", "分子生物学",
            "疾病", "诊断", "治疗", "手术", "疫苗", "抗体",
        ],
    },
    {
        "file":  "engineering.json",
        "label": "Materials & Engineering (材料与工程)",
        "keywords": [
            "材料", "纳米", "半导体", "合金", "陶瓷", "高分子材料",
            "工程", "机械", "电子", "通信", "能源", "核能",
            "航空", "航天", "土木", "化工",
        ],
    },
]

# Build a fast lookup: keyword → topic index
_KW_TO_TOPIC: list[tuple[str, int]] = []
for _idx, _t in enumerate(TOPICS):
    for _kw in _t["keywords"]:
        _KW_TO_TOPIC.append((_kw, _idx))
# Sort by length descending so longer / more specific keywords match first
_KW_TO_TOPIC.sort(key=lambda x: len(x[0]), reverse=True)


def classify(text: str) -> int:
    """Return the topic index (0-based) for this article, or -1 if no match."""
    if len(text) < MIN_CHARS:
        return -1
    snippet = text[:600]
    for kw, idx in _KW_TO_TOPIC:
        if kw in snippet:
            return idx
    return -1


# ── File & state helpers ────────────────────────────────────────────────────

def _out(topic_idx: int) -> str:
    return os.path.join(OUTPUT_DIR, TOPICS[topic_idx]["file"])


def _state_path() -> str:
    return os.path.join(OUTPUT_DIR, STATE_FILE)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load_state() -> dict:
    p = _state_path()
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                s = json.load(f)
            s.setdefault("seen_ids", [])
            s.setdefault("source_index", 0)        # which source we are on
            s.setdefault("row_index", 0)           # next row within current source
            s.setdefault("topic_bytes", {})
            s.setdefault("total_articles", 0)
            s.setdefault("sealed_files", [])
            return s
        except Exception as e:
            print(f"[warn] Cannot read state ({e}). Starting fresh.")
    return {
        "seen_ids": [],
        "source_index": 0,
        "row_index": 0,
        "topic_bytes": {},
        "total_articles": 0,
        "sealed_files": [],
    }


def save_state(state: dict):
    with open(_state_path(), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def _seal_if_full(topic_idx: int, state: dict):
    """If a topic file has reached MAX_FILE_BYTES, write SHA-256 sidecar."""
    fname = TOPICS[topic_idx]["file"]
    path  = _out(topic_idx)
    byt   = state["topic_bytes"].get(fname, 0)
    if byt < MAX_FILE_BYTES or not os.path.exists(path):
        return
    # Check it hasn't been sealed already
    already = [sf["file"] for sf in state["sealed_files"]]
    if fname in already:
        return
    digest  = sha256_file(path)
    sidecar = path + ".sha256"
    with open(sidecar, "w") as f:
        f.write(f"{digest}  {fname}\n")
    state["sealed_files"].append({"file": fname, "bytes": byt, "sha256": digest})
    print(f"  [sealed] {fname}  {byt/1e6:.1f} MB  sha256={digest[:16]}...")


def write_article(text: str, topic_idx: int, state: dict) -> bool:
    """
    Write one article to its topic file.
    Returns False (and skips) if the topic file is already at/over the 20 MB cap.
    """
    fname = TOPICS[topic_idx]["file"]
    byt   = state["topic_bytes"].get(fname, 0)
    if byt >= MAX_FILE_BYTES:
        return False        # this topic's file is full

    record = json.dumps({"text": text}, ensure_ascii=False) + "\n"
    rb     = len(record.encode("utf-8"))

    with open(_out(topic_idx), "a", encoding="utf-8") as fout:
        fout.write(record)

    state["topic_bytes"][fname] = byt + rb
    state["total_articles"]    += 1
    _seal_if_full(topic_idx, state)
    return True


# ── Download ────────────────────────────────────────────────────────────────

def _load_hf_dataset(src: dict):
    """Try each config variant for a source and return (ds, config_name) or (None, None)."""
    try:
        import datasets as hf_datasets
    except ImportError:
        print("ERROR: 'datasets' not installed.  Run: pip install datasets huggingface-hub")
        return None, None
    DOWNLOAD_PARQUET_NUM = 35
    for cfg in src["configs"]:
        try:
            kwargs = dict(split=src["split"], trust_remote_code=True)
            if cfg is not None:
                kwargs["name"] = cfg

            if src["id"] == "chinese_edu_web":
                file_list = [f"IndustryCorpus/{i:05d}.parquet" for i in range(DOWNLOAD_PARQUET_NUM)]
                kwargs["data_files"] = {src["split"]: file_list}
                # 关闭数据集大小校验，避免元数据和实际文件数量不一致报错
                kwargs["verification_mode"] = "no_checks"

            ds = hf_datasets.load_dataset(src["dataset"],cache_dir=CACHE_DIR,**kwargs)
            label = f"{src['dataset']} ({cfg})" if cfg else src["dataset"]
            print(f"  Loaded {label}  ({len(ds):,} rows)")
            return ds, cfg
        except Exception as e:
            label = f"{src['dataset']} ({cfg})" if cfg else src["dataset"]
            print(f"  {label}: {type(e).__name__}: {str(e)[:120]}")
    return None, None


def _get_text(row: dict, text_fields: list) -> str:
    """Extract text from a dataset row using the first matching field."""
    parts = []
    for f in text_fields:
        val = (row.get(f) or "").strip()
        if val:
            parts.append(val)
    return " ".join(parts)


def cmd_download(state: dict, max_articles: int):
    """
    Round-robin across all sources: take up to (max_articles / N) articles from
    each source per run, so every source contributes data from the very first run.
    """
    seen    = set(state["seen_ids"])
    written = 0

    # Print per-topic targets at start
    print("\nTopic → file mapping:")
    for t in TOPICS:
        byt    = state["topic_bytes"].get(t["file"], 0)
        sealed = t["file"] in [sf["file"] for sf in state["sealed_files"]]
        status = f"FULL ({byt/1e6:.1f} MB)" if sealed else f"{byt/1e6:.2f} / 20 MB"
        print(f"  {t['file']:20s}  {t['label']:35s}  {status}")

    # Per-source row cursors: {source_id: row_index}
    cursors: dict = state.setdefault("cursors", {})
    exhausted: set = set(state.setdefault("exhausted_sources", []))

    active_sources = [s for s in SOURCES if s["id"] not in exhausted]
    if not active_sources:
        print("\nAll sources exhausted. Nothing to do.")
        _print_summary(state)
        return

    # Budget per source this run (round-robin share)
    per_source = max(1, max_articles // len(active_sources))
    print(f"\n{len(active_sources)} active source(s), "
          f"~{per_source:,} articles each this run  (total target: {max_articles:,})\n")

    for src in active_sources:
        sid       = src["id"]
        row_start = cursors.get(sid, 0)

        print(f"[{sid}] Loading {src['dataset']} from row {row_start:,} ...")
        ds, _ = _load_hf_dataset(src)
        if ds is None:
            print(f"  Skipping {sid} (could not load).")
            continue

        src_written = 0
        scanned     = 0

        for idx in range(row_start, len(ds)):
            if src_written >= per_source:
                cursors[sid] = idx
                break

            row = ds[idx]
            uid = f"{sid}:{row.get('id', idx)}"
            if uid in seen:
                continue

            text      = _get_text(row, src["text_fields"])
            topic_idx = classify(text)
            seen.add(uid)
            if topic_idx == -1:
                continue

            ok = write_article(text, topic_idx, state)
            scanned += 1
            if ok:
                src_written += 1
                written     += 1

            if scanned % 500 == 0:
                state["seen_ids"] = list(seen)
                cursors[sid]      = idx + 1
                save_state(state)
                sizes = "  ".join(
                    f"{t['file']}={state['topic_bytes'].get(t['file'], 0)/1e6:.1f}MB"
                    for t in TOPICS
                )
                print(f"  [{sid}] row={idx:,}  +{src_written}  |  {sizes}")
        else:
            # Exhausted this source
            cursors[sid] = len(ds)
            exhausted.add(sid)
            print(f"  [{sid}] fully exhausted ({len(ds):,} rows).  "
                  f"Written from this source this run: {src_written:,}")

        print(f"  [{sid}] done this run: +{src_written:,} articles  "
              f"(cursor row {cursors.get(sid, '?'):,})")

        state["seen_ids"]          = list(seen)
        state["cursors"]           = cursors
        state["exhausted_sources"] = list(exhausted)
        save_state(state)

    save_state(state)
    print(f"\nDone this run.  Written={written:,} articles total")
    print(f"Grand total ever: {state['total_articles']:,}")
    _print_summary(state)


# ── Status & verify ─────────────────────────────────────────────────────────

def _print_summary(state: dict):
    print("\n=== Topic file summary ===")
    for t in TOPICS:
        fname  = t["file"]
        byt    = state["topic_bytes"].get(fname, 0)
        sealed = fname in [sf["file"] for sf in state["sealed_files"]]
        tag    = " [SEALED]" if sealed else ""
        print(f"  {fname:20s}  {t['label']:35s}  {byt/1e6:6.2f} MB{tag}")
    print("\n=== Source cursors ===")
    cursors   = state.get("cursors", {})
    exhausted = set(state.get("exhausted_sources", []))
    for src in SOURCES:
        sid  = src["id"]
        row  = cursors.get(sid, 0)
        tag  = " [EXHAUSTED]" if sid in exhausted else ""
        print(f"  {sid:20s}  row {row:>8,}{tag}")


def cmd_status(state: dict):
    print(f"Total articles downloaded: {state['total_articles']:,}")
    _print_summary(state)


def cmd_verify():
    sidecars = sorted(f for f in os.listdir(OUTPUT_DIR) if f.endswith(".json.sha256"))
    if not sidecars:
        print(f"No .sha256 sidecar files found in {OUTPUT_DIR}.")
        return
    all_ok = True
    for sc in sidecars:
        sc_path   = os.path.join(OUTPUT_DIR, sc)
        data_path = sc_path[:-7]
        if not os.path.exists(data_path):
            print(f"  MISSING  {sc[:-7]}")
            all_ok = False
            continue
        expected = open(sc_path).read().split()[0]
        actual   = sha256_file(data_path)
        ok       = actual == expected
        print(f"  {'OK     ' if ok else 'CORRUPT'}  {sc[:-7]}  sha256={actual[:16]}...")
        if not ok:
            all_ok = False
    print("All files OK." if all_ok else "Some files FAILED checksum.")


def cmd_test_sources():
    """
    Try to load the first row from each source and show:
      - whether the dataset is reachable
      - the actual field names available
      - a sample of extracted text
      - how classify() scores it
    """
    try:
        import datasets as hf_datasets  # noqa: F401
    except ImportError:
        print("ERROR: 'datasets' not installed.  Run: pip install datasets huggingface-hub")
        return

    print(f"Testing {len(SOURCES)} sources via {os.environ['HF_ENDPOINT']} ...\n")
    for src in SOURCES:
        sid = src["id"]
        print(f"{'─'*60}")
        print(f"[{sid}]  {src['dataset']}")
        print(f"  Note  : {src.get('note', '')}")
        ds, cfg = _load_hf_dataset(src)
        if ds is None:
            print(f"  RESULT: FAILED to load\n")
            continue

        print(f"  Size  : {len(ds):,} rows")
        row = ds[0]
        print(f"  Fields: {list(row.keys())}")

        text = _get_text(row, src["text_fields"])
        print(f"  Text  : {repr(text[:200])}")

        topic_idx = classify(text)
        if topic_idx == -1:
            # Try a few more rows to see if any match
            matched = None
            for i in range(1, min(200, len(ds))):
                t = _get_text(ds[i], src["text_fields"])
                ti = classify(t)
                if ti != -1:
                    matched = (i, ti, t)
                    break
            if matched:
                i, ti, t = matched
                print(f"  Class : row 0 = no match; first match at row {i} "
                      f"-> {TOPICS[ti]['label']}")
                print(f"  Sample: {repr(t[:200])}")
            else:
                print(f"  Class : no science match in first 200 rows "
                      f"(keywords may not match this dataset's style)")
        else:
            print(f"  Class : row 0 -> topic {topic_idx} = {TOPICS[topic_idx]['label']}")
        print()


# ── Entry point ─────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="Download topic-separated Chinese science data.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Topic → file mapping:\n" +
            "".join(f"  {t['file']:15s} {t['label']}\n" for t in TOPICS) +
            "\nExamples:\n"
            "  python download_science.py --output-dir C:/data\n"
            "  python download_science.py --output-dir C:/data --articles 5000\n"
            "  python download_science.py --output-dir C:/data --status\n"
            "  python download_science.py --output-dir C:/data --verify\n"
        ),
    )
    p.add_argument("--output-dir", default=".",
                   help="Directory for scienceN.json files (default: .).")
    p.add_argument("--articles", type=int, default=2000,
                   help="Max new articles to write this run (default: 2000).")
    p.add_argument("--status",       action="store_true", help="Show progress and exit.")
    p.add_argument("--verify",       action="store_true", help="Verify SHA-256 checksums.")
    p.add_argument("--test-sources", action="store_true",
                   help="Check each source: reachable? fields? sample text? classification?")
    p.add_argument("--cache-dir", default="/mnt/build/llm_data",
                   help="Directory for scienceN.json files (default: .).")
    return p.parse_args()


def main():
    global OUTPUT_DIR,CACHE_DIR
    args       = parse_args()
    OUTPUT_DIR = os.path.abspath(args.output_dir)
    CACHE_DIR = os.path.abspath(args.cache_dir)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"Output directory: {OUTPUT_DIR}")

    state = load_state()

    if args.status:
        cmd_status(state)
    elif args.verify:
        cmd_verify()
    elif args.test_sources:
        cmd_test_sources()
    else:
        cmd_download(state, max_articles=args.articles)


if __name__ == "__main__":
    main()
