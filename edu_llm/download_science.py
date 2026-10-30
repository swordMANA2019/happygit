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
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

def _default_cache_dir() -> str:
    return os.path.join(os.path.expanduser("~"), "Documents", "data", "hf_cache")

_cache_base = _default_cache_dir()
os.environ.setdefault("HF_HUB_CACHE", os.path.join(_cache_base, "hub"))
os.environ.setdefault("HF_DATASETS_CACHE", os.path.join(_cache_base, "datasets"))

import ssl

try:
    import certifi
    _ca_bundle = certifi.where()
    os.environ["SSL_CERT_FILE"] = _ca_bundle
    os.environ["REQUESTS_CA_BUNDLE"] = _ca_bundle
    os.environ["CURL_CA_BUNDLE"] = _ca_bundle
except ImportError:
    pass

# Corporate proxies (e.g. Zscaler) often MITM HTTPS; hf-mirror uses httpx.
ssl._create_default_https_context = ssl._create_unverified_context
try:
    import httpx
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    _httpx_client_init = httpx.Client.__init__
    _httpx_async_init = httpx.AsyncClient.__init__

    def _client_init_no_verify(self, *args, **kwargs):
        kwargs["verify"] = False
        _httpx_client_init(self, *args, **kwargs)

    def _async_init_no_verify(self, *args, **kwargs):
        kwargs["verify"] = False
        _httpx_async_init(self, *args, **kwargs)

    httpx.Client.__init__ = _client_init_no_verify
    httpx.AsyncClient.__init__ = _async_init_no_verify
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
CACHE_DIR = _default_cache_dir()
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
    # {
    #     # CC-100: requires dataset loading script — not supported by datasets>=5.0
    #     "id":          "cc100_zh",
    #     "dataset":     "parquet",
    #     "configs":     ["zh-Hans-CN"],
    #     "split":       "train",
    #     "text_fields": ["text"],
    #     "note":        "CC-100 Simplified Chinese web crawl",
    #     "parquet_glob": "hf://datasets/cc100/{config}/train-*.parquet",
    # },
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
# classify() scores every topic on the opening SNIPPET_LEN characters.
# Each keyword match adds weight = len(keyword); anchor hits add ANCHOR_BONUS.
# A topic wins only when it clears MIN_TOPIC_SCORE and beats the runner-up by
# MIN_SCORE_MARGIN (accuracy clarification — no hard-coded category exclusions).
SNIPPET_LEN = 600
MIN_TOPIC_SCORE = 4
MIN_SCORE_MARGIN = 2
ANCHOR_BONUS = 4
STRONG_SCORE = 10          # high score alone is enough without an anchor match

# Traditional → simplified (common in zh Wikipedia) for stable matching.
_T2S = str.maketrans({
    "學": "学", "與": "与", "國": "国", "劑": "剂", "機": "机", "體": "体",
    "電": "电", "質": "质", "變": "变", "濟": "济", "經": "经", "歷": "历",
    "時": "时", "間": "间", "這": "这", "個": "个", "們": "们", "來": "来",
    "說": "说", "會": "会", "對": "对", "無": "无", "環": "环", "應": "应",
    "現": "现", "實": "实", "驗": "验", "測": "测", "溫": "温", "壓": "压",
    "氣": "气", "陽": "阳", "陰": "阴", "離": "离", "還": "还", "總": "总",
    "統": "统", "計": "计", "數": "数", "結": "结", "構": "构", "組": "组",
    "織": "织", "繫": "系", "統": "统", "廣": "广", "義": "义", "藝": "艺",
    "術": "术", "區": "区", "網": "网", "際": "际", "訊": "讯", "視": "视",
    "聽": "听", "醫": "医", "藥": "药", "診": "诊", "療": "疗", "傳": "传",
    "統": "统", "動": "动", "態": "态", "場": "场", "類": "类", "種": "种",
    "為": "为", "從": "从", "過": "过", "進": "进", "開": "开", "發": "发",
    "關": "关", "係": "系", "聯": "联", "繫": "系", "標": "标", "準": "准",
    "圖": "图", "書": "书", "館": "馆", "識": "识", "認": "认", "證": "证",
    "據": "据", "讀": "读", "寫": "写", "編": "编", "劇": "剧", "觀": "观",
    "眾": "众", "裡": "里", "內": "内", "應": "应", "該": "该", "規": "规",
    "模": "模", "壓": "压", "歡": "欢", "迎": "迎", "歐": "欧", "無": "无",
    "線": "线", "組": "组", "成": "成", "絡": "络", "聯": "联", "繫": "系",
    "舉": "举", "行": "行", "變": "变", "成": "成", "認": "认", "識": "识",
    "讓": "让", "們": "们", "經": "经", "常": "常", "進": "进", "行": "行",
    "測": "测", "量": "量", "溫": "温", "度": "度", "環": "环", "與": "与",
})

def _normalize_zh(text: str) -> str:
    return text.translate(_T2S)


TOPICS = [
    {
        "file":  "chemistry.json",
        "label": "Chemistry (化学)",
        "anchors": ["化学", "化學", "有机化学", "無機化學", "无机化学", "化学元素", "化學元素"],
        "keywords": [
            "化学", "化學", "化学元素", "化學元素", "元素周期表", "週期表",
            "化合物", "化学键", "化學鍵", "有机化学", "無機化學", "无机化学",
            "化学反应", "化學反應", "化学式", "分子式", "化学计量", "摩尔",
            "门捷列夫", "門捷列夫", "拉瓦锡", "拉瓦錫", "道尔顿", "道爾頓",
            "居里", "酸碱", "酸鹼", "催化剂", "催化劑", "催化", "离子", "離子",
            "高分子", "溶液", "浓度", "濃度", "氧化反应", "還原反應", "还原反应",
            "化学工业", "化工原理", "谱学", "譜學",
        ],
    },
    {
        "file":  "physics.json",
        "label": "Physics (物理)",
        "anchors": ["物理学", "物理學", "量子力学", "量子力學", "电磁学", "電磁學"],
        "keywords": [
            "物理学", "物理學", "力学", "熱力學", "热力学", "电磁学", "电磁",
            "光学", "量子力学", "量子", "相对论", "相對論", "核物理", "流体力学",
            "固体物理", "声学", "粒子物理", "牛顿", "愛因斯坦", "爱因斯坦", "费曼",
            "薛定谔", "海森堡", "加速度", "动能", "势能", "动量", "引力",
            "电场", "磁场", "光速", "折射", "衍射", "干涉", "电磁波",
        ],
    },
    {
        "file":  "medicine.json",
        "label": "Medicine (医学)",
        "anchors": ["医学", "醫學", "免疫", "病理", "病理學"],
        "keywords": [
            "医学", "醫學", "解剖", "生理", "免疫", "药理", "藥理", "神经科学",
            "神經科學", "基因组", "基因組", "细胞生物学", "細胞生物學",
            "分子生物学", "分子生物學", "疾病", "诊断", "診斷", "治疗", "治療",
            "手术", "手術", "疫苗", "抗体", "抗體", "艾滋病", "愛滋病",
            "HIV", "病原体", "病原體",
        ],
    },
    {
        "file":  "biology.json",
        "label": "Biology (生物)",
        "anchors": ["生物学", "生物學", "植物学", "植物學", "动物学", "動物學"],
        "keywords": [
            "生物学", "生物學", "细胞", "細胞", "基因", "DNA", "RNA", "染色体",
            "染色體", "进化", "進化", "自然选择", "自然選擇", "遗传", "遺傳",
            "生态", "生態", "光合作用", "呼吸作用", "细胞膜", "細胞膜",
            "细胞核", "細胞核", "线粒体", "線粒體", "叶绿体", "葉綠體", "核糖体",
            "达尔文", "達爾文", "孟德尔", "孟德爾", "沃森", "克里克",
            "微生物", "细菌", "細菌", "病毒", "真菌", "生态系统", "生態系統",
            "蛋白质", "蛋白質", "酶", "氨基酸", "核酸", "植物学", "植物學",
            "动物学", "動物學", "古生物学", "古生物學",
        ],
    },
    {
        "file":  "mathematics.json",
        "label": "Mathematics (数学)",
        "anchors": ["数学", "數學", "数学家", "數學家"],
        "keywords": [
            "数学", "數學", "数学家", "數學家", "代数", "代數", "几何", "幾何",
            "微积分", "微積分", "统计学", "統計學", "概率论", "概率論",
            "数论", "數論", "拓扑", "拓撲", "线性代数", "線性代數",
            "微分方程", "离散数学", "離散數學", "数理逻辑", "數理邏輯",
            "函数", "函數", "极限", "極限", "导数", "導數", "积分", "積分",
            "勾股定理", "欧拉", "歐拉", "高斯", "黎曼", "费马", "費馬",
            "矩阵", "矩陣", "向量", "行列式", "集合论", "集合論",
        ],
    },
    {
        "file":  "computer_science.json",
        "label": "Computer Science (计算机科学)",
        "anchors": ["计算机科学", "計算機科學", "编程语言", "編程語言", "程序语言", "程式語言"],
        "keywords": [
            "计算机科学", "計算機科學", "程序设计", "程序設計", "程序语言",
            "程式語言", "编程语言", "編程語言", "算法", "数据结构", "數據結構",
            "人工智能", "机器学习", "機器學習", "神经网络", "神經網路",
            "操作系统", "操作系統", "编译器", "編譯器", "数据库", "數據庫",
            "网络协议", "網絡協議", "密码学", "密碼學", "图灵", "圖靈",
            "冯·诺依曼", "馮·諾依曼", "香农", "香農", "芯片设计", "芯片設計",
            "深度学习", "深度學習", "大语言模型", "大語言模型", "开源软件", "開源軟件",
        ],
    },
    {
        "file":  "astronomy.json",
        "label": "Astronomy (天文)",
        "anchors": ["天文学", "天文學", "天体", "天體"],
        "keywords": [
            "天文学", "天文學", "星系", "恒星", "恆星", "行星", "黑洞", "中子星",
            "太阳系", "太陽系", "银河系", "銀河系", "宇宙大爆炸", "暗物质", "暗物質",
            "暗能量", "红移", "紅移", "哈勃", "开普勒", "開普勒", "哥白尼",
            "伽利略", "望远镜", "望遠鏡", "光年", "超新星", "白矮星", "天体", "天體",
        ],
    },
    {
        "file":  "earth_science.json",
        "label": "Earth Science (地球科学)",
        "anchors": ["地球科学", "地球科學", "地质学", "地質學", "气象学", "氣象學"],
        "keywords": [
            "地球科学", "地球科學", "地质", "地質", "地质学", "地質學",
            "测绘", "測繪", "地球形状", "地球形狀", "地震", "火山", "板块", "板塊",
            "矿物", "礦物", "岩石", "化石", "气象", "氣象", "气候", "氣候",
            "大气", "大氣", "海洋", "洋流", "潮汐", "地壳", "地殼", "地幔", "地核", "地形",
        ],
    },
    {
        "file":  "engineering.json",
        "label": "Materials & Engineering (材料与工程)",
        "anchors": ["材料科学", "材料科學", "机械工程", "機械工程", "土木工程", "化学工程", "化學工程"],
        "keywords": [
            "材料科学", "材料科學", "材料工程", "纳米材料", "納米材料",
            "机械工程", "機械工程", "土木工程", "土木", "化工", "化学工程",
            "化學工程", "航空", "航天", "核能", "通信工程", "电子工程", "電子工程",
            "能源工程", "建筑工程", "冶金", "水利", "机器人", "機器人",
        ],
    },
]

# Pre-normalize anchor sets for scoring.
_TOPIC_ANCHORS: list[set[str]] = [
    {_normalize_zh(a) for a in t.get("anchors", [])} for t in TOPICS
]
_TOPIC_KEYWORDS: list[list[str]] = [t["keywords"] for t in TOPICS]


def _score_topics(snippet: str) -> list[float]:
    """Return weighted keyword scores for each topic on a normalized snippet."""
    scores = [0.0] * len(TOPICS)
    for idx, keywords in enumerate(_TOPIC_KEYWORDS):
        seen: set[str] = set()
        anchor_hit = False
        for kw in keywords:
            nkw = _normalize_zh(kw)
            if len(nkw) < 2 or nkw in seen:
                continue
            if nkw not in snippet:
                continue
            seen.add(nkw)
            scores[idx] += len(nkw)
            if nkw in _TOPIC_ANCHORS[idx]:
                anchor_hit = True
        if anchor_hit:
            scores[idx] += ANCHOR_BONUS
    return scores


def classify(text: str) -> int:
    """Return the topic index with the clearest score, or -1 if ambiguous."""
    if len(text) < MIN_CHARS:
        return -1
    snippet = _normalize_zh(text[:SNIPPET_LEN])
    scores = _score_topics(snippet)
    if not scores or max(scores) <= 0:
        return -1

    ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
    best_idx, best_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else 0.0

    if best_score < MIN_TOPIC_SCORE:
        return -1
    if second_score > 0 and (best_score - second_score) < MIN_SCORE_MARGIN:
        return -1

    has_anchor = any(
        _normalize_zh(a) in snippet for a in TOPICS[best_idx].get("anchors", [])
    )
    if not has_anchor and best_score < STRONG_SCORE:
        return -1

    return best_idx


def classify_detail(text: str) -> tuple[int, list[float]]:
    """Like classify() but also return per-topic scores (for diagnostics)."""
    if len(text) < MIN_CHARS:
        return -1, [0.0] * len(TOPICS)
    scores = _score_topics(_normalize_zh(text[:SNIPPET_LEN]))
    return classify(text), scores


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
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    for cfg in src["configs"]:
        try:
            kwargs = dict(split=src["split"])
            if cfg is not None:
                kwargs["name"] = cfg

            if src["id"] == "cc100_zh":
                glob = src["parquet_glob"].format(config=cfg)
                kwargs = dict(
                    split=src["split"],
                    data_files={src["split"]: glob},
                )
                ds = hf_datasets.load_dataset("parquet", cache_dir=CACHE_DIR, **kwargs)
            elif src["id"] == "chinese_edu_web":
                file_list = [f"IndustryCorpus/{i:05d}.parquet" for i in range(DOWNLOAD_PARQUET_NUM)]
                kwargs["data_files"] = {src["split"]: file_list}
                # 关闭数据集大小校验，避免元数据和实际文件数量不一致报错
                kwargs["verification_mode"] = "no_checks"
                ds = hf_datasets.load_dataset(src["dataset"], cache_dir=CACHE_DIR, **kwargs)
            elif src["id"] == "cci3_hq":
                if not hf_token:
                    print(f"  {src['dataset']}: skipped (gated dataset — set HF_TOKEN to enable)")
                    continue
                kwargs["token"] = hf_token
                ds = hf_datasets.load_dataset(src["dataset"], cache_dir=CACHE_DIR, **kwargs)
            else:
                ds = hf_datasets.load_dataset(src["dataset"], cache_dir=CACHE_DIR, **kwargs)
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


def cmd_refilter(state: dict):
    """Reclassify all articles in topic JSON files using current rules."""
    file_to_idx = {t["file"]: i for i, t in enumerate(TOPICS)}
    buckets: list[list[str]] = [[] for _ in TOPICS]
    kept = moved = dropped = 0

    for fname, src_idx in file_to_idx.items():
        path = os.path.join(OUTPUT_DIR, fname)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                text = json.loads(line)["text"]
                dst = classify(text)
                if dst == -1:
                    dropped += 1
                    continue
                if dst != src_idx:
                    moved += 1
                else:
                    kept += 1
                buckets[dst].append(text)

    for i, t in enumerate(TOPICS):
        path = _out(i)
        with open(path, "w", encoding="utf-8") as f:
            for text in buckets[i]:
                f.write(json.dumps({"text": text}, ensure_ascii=False) + "\n")

    state["topic_bytes"] = {}
    state["sealed_files"] = []
    total = 0
    for t in TOPICS:
        path = os.path.join(OUTPUT_DIR, t["file"])
        byt  = os.path.getsize(path) if os.path.exists(path) else 0
        state["topic_bytes"][t["file"]] = byt
        total += len(buckets[file_to_idx[t["file"]]])
    state["total_articles"] = total
    save_state(state)

    print(f"\nRefilter complete.")
    print(f"  Kept in place : {kept:,}")
    print(f"  Moved         : {moved:,}")
    print(f"  Dropped       : {dropped:,}  (no longer match any topic)")
    print(f"  Total kept    : {total:,}")
    _print_summary(state)


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

        topic_idx, scores = classify_detail(text)
        if topic_idx == -1:
            print(f"  Scores: {_format_top_scores(scores)}")
            matched = None
            for i in range(1, min(200, len(ds))):
                t = _get_text(ds[i], src["text_fields"])
                ti, sc = classify_detail(t)
                if ti != -1:
                    matched = (i, ti, t, sc)
                    break
            if matched:
                i, ti, t, sc = matched
                print(f"  Class : row 0 = no match; first match at row {i} "
                      f"-> {TOPICS[ti]['label']}")
                print(f"  Scores: {_format_top_scores(sc)}")
                print(f"  Sample: {repr(t[:200])}")
            else:
                print(f"  Class : no science match in first 200 rows "
                      f"(scores too low or ambiguous)")
        else:
            print(f"  Class : row 0 -> topic {topic_idx} = {TOPICS[topic_idx]['label']}")
            print(f"  Scores: {_format_top_scores(scores)}")
        print()


def _apply_classify_config(args) -> None:
    """Override scoring thresholds from CLI (defaults live in module constants)."""
    global MIN_TOPIC_SCORE, MIN_SCORE_MARGIN, STRONG_SCORE
    MIN_TOPIC_SCORE = args.min_topic_score
    MIN_SCORE_MARGIN = args.min_score_margin
    STRONG_SCORE = args.strong_score


def _format_top_scores(scores: list[float], n: int = 3) -> str:
    ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
    parts = []
    for idx, score in ranked[:n]:
        if score <= 0:
            break
        parts.append(f"{TOPICS[idx]['file']}={score:.0f}")
    return ", ".join(parts) if parts else "none"


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
    p.add_argument("--refilter",     action="store_true",
                   help="Reclassify existing topic JSON files with current rules.")
    p.add_argument("--test-sources", action="store_true",
                   help="Check each source: reachable? fields? sample text? classification?")
    p.add_argument("--cache-dir", default=_default_cache_dir(),
                   help="Hugging Face cache directory (default: ~/Documents/data/hf_cache).")
    p.add_argument("--min-topic-score", type=int, default=MIN_TOPIC_SCORE,
                   help="Minimum weighted score to assign a topic (default: %(default)s).")
    p.add_argument("--min-score-margin", type=int, default=MIN_SCORE_MARGIN,
                   help="Winner must lead runner-up by this margin (default: %(default)s).")
    p.add_argument("--strong-score", type=int, default=STRONG_SCORE,
                   help="Score that qualifies without an anchor match (default: %(default)s).")
    return p.parse_args()


def main():
    global OUTPUT_DIR, CACHE_DIR
    args       = parse_args()
    _apply_classify_config(args)
    OUTPUT_DIR = os.path.abspath(args.output_dir)
    CACHE_DIR  = os.path.abspath(args.cache_dir)
    os.environ["HF_HUB_CACHE"]      = os.path.join(CACHE_DIR, "hub")
    os.environ["HF_DATASETS_CACHE"] = os.path.join(CACHE_DIR, "datasets")
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(CACHE_DIR, exist_ok=True)
    print(f"Output directory: {OUTPUT_DIR}")

    state = load_state()

    if args.status:
        cmd_status(state)
    elif args.verify:
        cmd_verify()
    elif args.refilter:
        cmd_refilter(state)
    elif args.test_sources:
        cmd_test_sources()
    else:
        cmd_download(state, max_articles=args.articles)


if __name__ == "__main__":
    main()
