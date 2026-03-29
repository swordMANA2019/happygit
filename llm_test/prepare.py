import multiprocessing
import os
import re
from glob import glob

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


def iter_local_zh_wiki_science(xml_glob):
    # LOCAL_WIKI_XML_GLOB example:
    # C:/wiki_dump/zhwiki-20260301-pages-articles-multistream*.xml*.bz2
    files = sorted(glob(xml_glob))
    if not files:
        raise FileNotFoundError(f"No local dump files matched: {xml_glob}")
    print(f"Using local XML dumps ({len(files)} files): {xml_glob}")

    # Reuse the parser/cleaner from local wikipedia script.
    from wikipedia import _clean_content, _extract_content

    for file in tqdm(files, desc="Parsing local dump files"):
        for inputs in _extract_content(file):
            title = inputs[1] or ""
            if _TITLE_RE.search(title) is None:
                continue
            item = _clean_content(inputs, "zh")
            if item is None:
                continue
            yield item

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


def split_to_chunks(text, chunk_chars=220, stride_chars=180):
    if len(text) <= chunk_chars:
        return [text]
    chunks = []
    i = 0
    while i < len(text):
        piece = text[i : i + chunk_chars].strip()
        if piece:
            chunks.append(piece)
        i += stride_chars
    return chunks

# ======================
# 3. 生成预训练 .txt
# ======================
def build_pretrain_file(ds, out_path="science_pretrain.txt", min_len=120):
    kept = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for item in tqdm(ds):
            title = clean_zh_text(item.get("title") or "")
            text = item.get("text") or ""
            text = clean_zh_text(text)
            if len(text) < min_len:
                continue
            for chunk in split_to_chunks(text):
                if len(chunk) < min_len:
                    continue
                # Keep title for stronger science-knowledge grounding.
                sample = f"标题：{title}。内容：{chunk}" if title else chunk
                f.write(sample + "\n")
                kept += 1
    return kept

if __name__ == "__main__":
    data_path = os.path.join(os.getcwd(), "data", "science_pretrain.txt")
    os.makedirs(os.path.dirname(data_path), exist_ok=True)
    local_xml_glob = os.environ.get("LOCAL_WIKI_XML_GLOB", "").strip()
    if local_xml_glob:
        wiki_records = iter_local_zh_wiki_science(local_xml_glob)
    else:
        print(f"Using Wikipedia dump date: {os.environ.get('WIKI_DATE', '20260301')}")
        wiki_records = load_zh_wiki_science()

    num_samples = build_pretrain_file(wiki_records, out_path=data_path)
    if num_samples == 0:
        raise RuntimeError(
            "No samples were written to science_pretrain.txt. "
            "Check filter keywords/date/language config "
            "(try WIKI_DATE=20260201 or LOCAL_WIKI_XML_GLOB=...xml.bz2)."
        )
    print(f"Wrote {num_samples} samples to: {data_path}")
