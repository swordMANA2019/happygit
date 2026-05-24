#!/usr/bin/env python3
"""
download_science.py
───────────────────
Downloads Chinese science-education articles from multiple Wikimedia projects
(zh.wikipedia.org, zh.wikiversity.org, zh.wikibooks.org) and saves them to
auto-numbered JSONL files, each capped at 20 MB:

    science1.json   science2.json   science3.json  …
    science1.json.sha256  …   (SHA-256 sidecar, written when a file is sealed)

A state file (science_state.json) records every article already downloaded.
Re-running always fetches ONLY NEW data — no duplicates across runs.

Sources
───────
  1. hf-mirror.com  —  Chinese Wikipedia via Hugging Face datasets mirror
                        (accessible inside China; no API key needed)
  2. zh.wikipedia.org  —  MediaWiki API direct
                        (works outside China or with a VPN)

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
# hf-mirror.com is the Chinese mirror of Hugging Face, accessible in China.
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
# Disable SSL cert verification for requests (used by huggingface_hub internally).
# This is safe for public read-only dataset downloads.
os.environ["CURL_CA_BUNDLE"] = ""
os.environ["REQUESTS_CA_BUNDLE"] = ""

# Fix SSL for Python's urllib as well.
import ssl
ssl._create_default_https_context = ssl._create_unverified_context

# Disable SSL verification globally in requests (if installed).
try:
    import requests
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    _orig_send = requests.Session.send
    def _send_no_verify(self, request, **kwargs):
        kwargs["verify"] = False
        return _orig_send(self, request, **kwargs)
    requests.Session.send = _send_no_verify
except ImportError:
    pass

import argparse
import hashlib
import json
import time
from typing import Optional

# ── stdout safe for Chinese on Windows (cp1252 console) ───────────────────
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── Configuration ─────────────────────────────────────────────────────────
MAX_FILE_BYTES = 20 * 1024 * 1024   # 20 MB per output file
STATE_FILE     = "science_state.json"
MIN_CHARS      = 200                 # discard stubs shorter than this
OUTPUT_DIR     = "."                 # overridden by --output-dir

# Science / STEM keyword filter: article must contain at least one of these.
SCIENCE_KEYWORDS = {
    "物理", "化学", "生物", "数学", "天文", "地质", "地球", "气象",
    "计算机", "医学", "工程", "科学", "力学", "量子", "相对论",
    "遗传", "进化", "细胞", "分子", "原子", "元素", "能量", "光学",
    "电磁", "热力学", "统计学", "神经", "免疫", "生态", "宇宙",
    "行星", "恒星", "黑洞", "算法", "数据", "人工智能", "材料",
    "纳米", "半导体", "核能", "基因", "蛋白质", "酶", "催化",
}


def is_science(text: str) -> bool:
    if len(text) < MIN_CHARS:
        return False
    snippet = text[:600]
    return any(kw in snippet for kw in SCIENCE_KEYWORDS)


# ── File & state helpers ───────────────────────────────────────────────────

def _out(file_num: int) -> str:
    return os.path.join(OUTPUT_DIR, f"science{file_num}.json")


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
            s.setdefault("seen_ids", {})
            s.setdefault("cur_file_num", 1)
            s.setdefault("cur_file_bytes", 0)
            s.setdefault("total_articles", 0)
            s.setdefault("source_cursors", {})
            s.setdefault("sealed_files", [])
            return s
        except Exception as e:
            print(f"[warn] Cannot read state ({e}). Starting fresh.")
    return {
        "seen_ids": {},
        "cur_file_num": 1,
        "cur_file_bytes": 0,
        "total_articles": 0,
        "source_cursors": {},
        "sealed_files": [],
    }


def save_state(state: dict):
    with open(_state_path(), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def seal_file(state: dict):
    """Compute SHA-256, write sidecar, advance to next file number."""
    path = _out(state["cur_file_num"])
    if not os.path.exists(path):
        return
    digest = sha256_file(path)
    sidecar = path + ".sha256"
    with open(sidecar, "w") as f:
        f.write(f"{digest}  {os.path.basename(path)}\n")
    state["sealed_files"].append({
        "file": os.path.basename(path),
        "bytes": state["cur_file_bytes"],
        "sha256": digest,
    })
    print(f"  [seal] {os.path.basename(path)}  "
          f"{state['cur_file_bytes']/1e6:.1f} MB  sha256={digest[:16]}…")
    state["cur_file_num"] += 1
    state["cur_file_bytes"] = 0


def write_article(text: str, state: dict):
    """Append one article to the current output file, rolling over if needed."""
    record = json.dumps({"text": text}, ensure_ascii=False) + "\n"
    rb = record.encode("utf-8")

    if state["cur_file_bytes"] + len(rb) > MAX_FILE_BYTES and state["cur_file_bytes"] > 0:
        seal_file(state)
        save_state(state)

    with open(_out(state["cur_file_num"]), "a", encoding="utf-8") as fout:
        fout.write(record)

    state["cur_file_bytes"] += len(rb)
    state["total_articles"] += 1


# ── Source 1: Hugging Face mirror — Chinese Wikipedia ─────────────────────

def _hf_wikipedia_zh(state: dict, max_articles: int) -> int:
    """
    Stream the Chinese Wikipedia dataset from hf-mirror.com.
    Requires: pip install datasets huggingface-hub
    """
    try:
        import datasets as hf_datasets
    except ImportError:
        print("[hf-wikipedia] 'datasets' library not installed. "
              "Run: pip install datasets huggingface-hub")
        return 0

    src_id = "hf-wikipedia-zh"
    seen = set(state["seen_ids"].get(src_id, []))
    cursors = state["source_cursors"].setdefault(src_id, {})
    start_idx = cursors.get("row_index", 0)

    if start_idx == -1:
        print("[hf-wikipedia] Already exhausted.")
        return 0

    print(f"[hf-wikipedia] Loading dataset from {os.environ.get('HF_ENDPOINT')} "
          f"(start row={start_idx:,}) …")
    print("  (First run downloads the dataset; subsequent runs use local cache.)")

    ds = None
    # wikimedia/wikipedia uses pre-built parquet files — no dump verification needed.
    for version in ("20231101.zh", "20230601.zh", "20220301.zh"):
        try:
            ds = hf_datasets.load_dataset(
                "wikimedia/wikipedia",
                version,
                split="train",
                trust_remote_code=True,
            )
            print(f"[hf-wikipedia] Loaded wikimedia/wikipedia {version}  "
                  f"({len(ds):,} articles)")
            break
        except Exception as e:
            print(f"[hf-wikipedia]   wikimedia/wikipedia {version}: "
                  f"{type(e).__name__}: {str(e)[:120]}")

    # Fallback: the 'wikipedia' package (SSL already patched globally).
    if ds is None:
        for version in ("20260301.zh",):
            try:
                ds = hf_datasets.load_dataset(
                    "wikipedia",
                    version,
                    split="train",
                    trust_remote_code=True,
                )
                print(f"[hf-wikipedia] Loaded wikipedia {version}  "
                      f"({len(ds):,} articles)")
                break
            except Exception as e:
                print(f"[hf-wikipedia]   wikipedia {version}: "
                      f"{type(e).__name__}: {str(e)[:120]}")

    if ds is None:
        print("[hf-wikipedia] Could not load any Wikipedia dataset.")
        print(f"  HF_ENDPOINT={os.environ.get('HF_ENDPOINT')}")
        print("  Try: pip install -U datasets huggingface-hub")
        return 0

    print(f"[hf-wikipedia] Dataset loaded: {len(ds):,} articles. "
          f"Resuming from row {start_idx:,} …")

    count = 0
    for idx in range(start_idx, len(ds)):
        if count >= max_articles:
            cursors["row_index"] = idx
            break

        row = ds[idx]
        uid = str(row.get("id", idx))
        if uid in seen:
            continue

        text = (row.get("text") or "").strip()
        if not is_science(text):
            continue

        write_article(text, state)
        seen.add(uid)
        count += 1

        if count % 200 == 0:
            state["seen_ids"][src_id] = list(seen)
            cursors["row_index"] = idx + 1
            save_state(state)
            print(f"  row={idx:,}  science_articles={count:,}  "
                  f"file=science{state['cur_file_num']}.json  "
                  f"{state['cur_file_bytes']/1e6:.1f} MB")
    else:
        # Loop finished naturally — dataset exhausted.
        cursors["row_index"] = -1

    state["seen_ids"][src_id] = list(seen)
    save_state(state)
    print(f"[hf-wikipedia] Done. Fetched {count:,} new science articles.")
    return count


# ── Source 2: MediaWiki API (direct, works outside China / with VPN) ──────

_MEDIAWIKI_SOURCES = [
    {"id": "wikipedia-zh",    "host": "zh.wikipedia.org"},
    {"id": "wikiversity-zh",  "host": "zh.wikiversity.org"},
    {"id": "wikibooks-zh",    "host": "zh.wikibooks.org"},
]

_MEDIAWIKI_CATEGORIES = [
    "物理学", "化学", "生物学", "数学", "天文学", "地球科学",
    "计算机科学", "医学", "工程学", "自然科学", "量子力学",
    "遗传学", "有机化学", "统计学", "神经科学", "材料科学",
    "光学", "热力学", "核物理学", "流体力学", "生态学",
]


def _mediawiki_get(host: str, params: dict) -> dict:
    import urllib.request, urllib.parse, urllib.error
    params.setdefault("format", "json")
    params.setdefault("formatversion", "2")
    url = f"https://{host}/w/api.php?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, headers={"User-Agent": "ScienceDataBot/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"  [warn] {host}: {e}")
        return {}


def _mediawiki_sources(state: dict, max_articles: int) -> int:
    import urllib.request
    # Quick connectivity check.
    try:
        urllib.request.urlopen(
            "https://zh.wikipedia.org/w/api.php?action=query&format=json",
            timeout=8)
    except Exception:
        print("[mediawiki] zh.wikipedia.org not reachable (blocked?). Skipping.")
        return 0

    total = 0
    for src in _MEDIAWIKI_SOURCES:
        if total >= max_articles:
            break
        src_id = src["id"]
        host   = src["host"]
        seen   = set(state["seen_ids"].get(src_id, []))
        cats   = state["source_cursors"].setdefault(src_id, {})

        print(f"\n[mediawiki:{src_id}]  seen={len(seen):,}")

        for cat in _MEDIAWIKI_CATEGORIES:
            if total >= max_articles:
                break
            cursor = cats.get(cat)
            if cursor == "DONE":
                continue

            while total < max_articles:
                params = {"action": "query", "list": "categorymembers",
                          "cmtitle": f"Category:{cat}", "cmnamespace": "0",
                          "cmlimit": "500", "cmprop": "ids"}
                if cursor:
                    params["cmcontinue"] = cursor
                data = _mediawiki_get(host, params)
                time.sleep(0.4)

                members = data.get("query", {}).get("categorymembers", [])
                new_ids = [m["pageid"] for m in members
                           if str(m["pageid"]) not in seen]

                for i in range(0, len(new_ids), 20):
                    if total >= max_articles:
                        break
                    batch = new_ids[i:i+20]
                    ep = _mediawiki_get(host, {
                        "action": "query",
                        "pageids": "|".join(str(x) for x in batch),
                        "prop": "extracts", "explaintext": "1",
                        "exsectionformat": "plain",
                    })
                    time.sleep(0.4)
                    pages = ep.get("query", {}).get("pages", [])
                    for p in pages:
                        text = (p.get("extract") or "").strip()
                        if not is_science(text):
                            continue
                        write_article(text, state)
                        seen.add(str(p["pageid"]))
                        total += 1

                cursor = data.get("continue", {}).get("cmcontinue")
                cats[cat] = cursor if cursor else "DONE"
                state["seen_ids"][src_id] = list(seen)
                save_state(state)

                if not cursor:
                    break

    return total


# ── Commands ──────────────────────────────────────────────────────────────

def cmd_status(state: dict):
    print("=== Science download status ===")
    print(f"  Total articles : {state['total_articles']:,}")
    print(f"  Sealed files   : {len(state['sealed_files'])}")
    for sf in state["sealed_files"]:
        print(f"    {sf['file']}  {sf['bytes']/1e6:.1f} MB  "
              f"sha256={sf['sha256'][:16]}…")
    cur = _out(state["cur_file_num"])
    size = os.path.getsize(cur) if os.path.exists(cur) else 0
    print(f"  Open file      : science{state['cur_file_num']}.json  "
          f"{size/1e6:.2f} MB / 20 MB")


def cmd_verify():
    sidecars = sorted(
        f for f in os.listdir(OUTPUT_DIR) if f.endswith(".json.sha256")
    )
    if not sidecars:
        print(f"No .sha256 sidecar files found in {OUTPUT_DIR}.")
        return
    all_ok = True
    for sc in sidecars:
        sc_path   = os.path.join(OUTPUT_DIR, sc)
        data_path = sc_path[:-7]          # strip ".sha256"
        if not os.path.exists(data_path):
            print(f"  MISSING  {sc[:-7]}")
            all_ok = False
            continue
        expected = open(sc_path).read().split()[0]
        actual   = sha256_file(data_path)
        ok = actual == expected
        print(f"  {'OK     ' if ok else 'CORRUPT'}  {sc[:-7]}  "
              f"sha256={actual[:16]}…")
        if not ok:
            all_ok = False
    print("All files OK." if all_ok else "Some files FAILED checksum.")


def cmd_download(state: dict, max_articles: int):
    print(f"Target: {max_articles:,} new articles  "
          f"-> {OUTPUT_DIR}")
    remaining = max_articles

    # Try HuggingFace mirror first (works in China).
    n = _hf_wikipedia_zh(state, remaining)
    remaining -= n

    # Try direct MediaWiki APIs (works outside China / with VPN).
    if remaining > 0:
        n2 = _mediawiki_sources(state, remaining)
        remaining -= n2

    cur = _out(state["cur_file_num"])
    actual = os.path.getsize(cur) if os.path.exists(cur) else 0
    print(f"\nFinished. Total articles ever: {state['total_articles']:,}")
    print(f"Current file: science{state['cur_file_num']}.json  "
          f"({actual/1e6:.2f} MB / 20 MB)")
    if state["sealed_files"]:
        print(f"Sealed files: {[sf['file'] for sf in state['sealed_files']]}")


# ── Entry point ────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="Download Chinese science-education data.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python download_science.py --output-dir C:/data\n"
            "  python download_science.py --output-dir C:/data --articles 5000\n"
            "  python download_science.py --output-dir C:/data --status\n"
            "  python download_science.py --output-dir C:/data --verify\n"
        ),
    )
    p.add_argument("--output-dir", default=".",
                   help="Directory for scienceN.json files (default: current dir).")
    p.add_argument("--articles", type=int, default=2000,
                   help="Max new articles to download this run (default: 2000).")
    p.add_argument("--status", action="store_true",
                   help="Print progress summary and exit.")
    p.add_argument("--verify", action="store_true",
                   help="Verify SHA-256 of all sealed files and exit.")
    return p.parse_args()


def main():
    global OUTPUT_DIR
    args = parse_args()
    OUTPUT_DIR = os.path.abspath(args.output_dir)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"Output directory: {OUTPUT_DIR}")

    state = load_state()

    if args.status:
        cmd_status(state)
        return
    if args.verify:
        cmd_verify()
        return

    cmd_download(state, max_articles=args.articles)


if __name__ == "__main__":
    main()
