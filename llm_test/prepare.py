import multiprocessing
import os
import re

import aiohttp
from datasets import load_dataset
from datasets.download.download_config import DownloadConfig
from tqdm import tqdm

# Local script: date comes from WIKI_DATE (default 20260301).
_WIKI_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wikipedia.py")

_EDU_KEYWORDS = [
    "物理", "化学", "生物", "数学", "地理", "天文",
    "科学", "医学", "工程", "计算机", "原理", "定律",
    "理论", "实验", "结构", "函数", "算法", "教育", "教材",
]
_TITLE_RE = re.compile("|".join(re.escape(k) for k in _EDU_KEYWORDS))


def _filter_title_batch(batch):
    return [_TITLE_RE.search((t or "")) is not None for t in batch["title"]]


# ======================
# 1. 加载中文维基（科教过滤）
# ======================
def load_zh_wiki_science():
    # 本地缓存后过滤比 streaming 快；维基 XML 走 fsspec/aiohttp，默认 ~5min 总超时会断在慢网上
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "600")
    dl = DownloadConfig(
        resume_download=True,
        max_retries=5,
        storage_options={
            "client_kwargs": {
                "timeout": aiohttp.ClientTimeout(total=None, sock_connect=120, sock_read=None),
            }
        },
    )
    wiki_date = os.environ.get("WIKI_DATE", "20260301")
    config_name = f"{wiki_date}.zh"
    ds = load_dataset(
        _WIKI_SCRIPT,
        config_name,
        split="train",
        trust_remote_code=True,
        streaming=False,
        download_config=dl,
    )
    nproc = min(8, max(1, multiprocessing.cpu_count() or 1))
    return ds.filter(_filter_title_batch, batched=True, batch_size=1000, num_proc=nproc)

# ======================
# 2. 清洗文本
# ======================
def clean_zh_text(text):
    # 去掉网址、邮箱、多余空格、换行
    text = re.sub(r"https?://\S+|www\.\S+", "", text)
    text = re.sub(r"\n+", " ", text)
    text = re.sub(r"\s+", " ", text)
    text = text.strip()
    return text

# ======================
# 3. 生成预训练 .txt
# ======================
def build_pretrain_file(ds, out_path="science_pretrain.txt", min_len=300):
    kept = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for item in tqdm(ds):
            text = item.get("text") or ""
            text = clean_zh_text(text)
            if len(text) < min_len:
                continue
            f.write(text + "\n")
            kept += 1
    return kept

if __name__ == "__main__":
    data_path = os.path.join(os.getcwd(), "data", "science_pretrain.txt")
    os.makedirs(os.path.dirname(data_path), exist_ok=True)
    print(f"Using Wikipedia dump date: {os.environ.get('WIKI_DATE', '20260301')}")
    wiki_ds = load_zh_wiki_science()
    num_samples = build_pretrain_file(wiki_ds, out_path=data_path)
    if num_samples == 0:
        raise RuntimeError(
            "No samples were written to science_pretrain.txt. "
            "Check filter keywords/date/language config (try WIKI_DATE=20260201)."
        )
    print(f"Wrote {num_samples} samples to: {data_path}")
