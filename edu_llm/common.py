import os
from transformers import AutoTokenizer
import re
import random
import hashlib
from collections import Counter
import torch
from transformers import Qwen2Config
import datasets
import numpy as np
from model import DecoderOnlyModel

MODEL_ID = os.environ.get("MODEL_ID", "Qwen/Qwen2-0.5B")
ids = ""

def get_data_paths(data_dir: str):
    """统一管理所有路径"""
    return {
        "data_json": os.path.join(data_dir, "wikipedia-zh-cn-20240820.json"),
        "tokenizer_dir": os.path.join(data_dir, "tokenizer"),
        "cache_root": data_dir,
        "train_output": os.path.join(data_dir, "train_output"),  # 训练检查点
        "model_weights": os.path.join(data_dir, "model_weights"),  # 最终模型
        "log_dir": os.path.join(data_dir, "train_logs"),  # 日志目录
    }

def load_tokenizer(tokenizer_dir: str):
    os.makedirs(tokenizer_dir, exist_ok=True)
    try:
        if not os.listdir(tokenizer_dir):
            tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
            tokenizer.save_pretrained(tokenizer_dir)
        return AutoTokenizer.from_pretrained(tokenizer_dir, local_files_only=True)
    except Exception as e:
        print(f"❌ Tokenizer加载失败：{e}")
        return None



# ==============================================
# 配置（你不用改太多）
# ==============================================
MIN_TEXT_LENGTH = 40
VALID_CHAR_THRESHOLD = 0.65
NGRAM_REPEAT_LIMIT = 3

# ==============================================
# 清洗器
# ==============================================
class DataCleaner:
    def __init__(self):
        # 你原来的基础清洗
        self.multi_comma_en = re.compile(r",{2,}")
        self.multi_comma_cn = re.compile(r"，{2,}")
        self.multi_space = re.compile(r"\s+")
        self.control_char = re.compile(r"[\x00-\x1F\x7F]")
        self.multi_punc = re.compile(r"([。！？.!?]){2,}")

        # 清理 空括号 / 只有标点的括号
        self.empty_brackets = re.compile(
            r"\(\s*[，。！？、；：\s]*\)|"
            r"（\s*[,，。！？、；：\s]*）"
        )

        # 质量过滤
        self.noise_pattern = re.compile(r"[^\w\s\u4e00-\u9fff.,!?;:'\"，。！？、；：‘’“”（）]")
        self.punctuation = set(".,!?;:'\"，。！？、；：‘’“”（）()")
        self.url_pattern = re.compile(r"http[s]?://\S+|www\.\S+")

        self._seen_hashes = set()

    def _basic_clean(self, text: str) -> str:
        if not text:
            return ""
        text = self.url_pattern.sub("", text)

        # 只清理空括号 / 纯标点括号
        text = self.empty_brackets.sub("", text)

        text = self.multi_comma_en.sub(",", text)
        text = self.multi_comma_cn.sub("，", text)
        text = self.multi_space.sub(" ", text)
        text = self.control_char.sub("", text)
        text = self.multi_punc.sub(r"\1", text)
        return text.strip()

    def _is_duplicate(self, text: str) -> bool:
        norm_text = text.strip().lower()
        h = hashlib.md5(norm_text.encode("utf-8")).hexdigest()
        if h in self._seen_hashes:
            return True
        self._seen_hashes.add(h)
        return False

    def _calc_ngram_dup_ratio(self, text, n=2):
        if len(text) < 2 * n:
            return 0.0
        ngrams = [text[i:i + n] for i in range(len(text) - n + 1)]
        if not ngrams:
            return 0.0
        counter = Counter(ngrams)
        return counter.most_common(1)[0][1] / len(ngrams)

    def _is_high_quality(self, text: str) -> bool:
        # 1. 过滤：太短的句子 → 没用
        if len(text) < 20:
            return False

        # 2. 过滤：重复率太高 → 复读机垃圾
        dup_ratio = self._calc_ngram_dup_ratio(text)
        if dup_ratio > 0.35:
            return False

        # 3. 过滤：乱码/特殊符号太多 → 不是正常文字
        noise = self.noise_pattern.findall(text)
        if len(noise) / len(text) > 0.15:
            return False

        # 4. 过滤：标点太少 → 不像正常句子
        punct = sum(1 for c in text if c in self.punctuation)
        return punct / len(text) >= 0.02

    def clean(self, text: str) -> str | None:
        cleaned = self._basic_clean(text)
        if not cleaned:
            return None
        if self._is_duplicate(cleaned):
            return None
        if not self._is_high_quality(cleaned):
            return None
        return cleaned


# ==============================================
# 过滤规则
# ==============================================
def is_valid_text(text):
    if len(text) < MIN_TEXT_LENGTH:
        return False
    valid_chars = re.findall(r"[\u4e00-\u9fa5a-zA-Z0-9]", text)
    return len(valid_chars) / len(text) >= VALID_CHAR_THRESHOLD

def has_ngram_repeat(text, n=10, threshold=3):
    if len(text) < n:
        return False
    ngrams = [text[i:i+n] for i in range(len(text) - n + 1)]
    cnt = Counter(ngrams)
    return any(v >= threshold for v in cnt.values())

# ==============================================
# 核心：给 datasets 用的清洗函数（map 专用）
# ==============================================

def clean_sample(sample):
    cleaner = DataCleaner()
    raw_text = sample["text"]
    text = cleaner.clean(raw_text)
    global ids
    if text is None:
        ids += sample["id"]
        ids += "\n"
    sample["text"] = text
    return sample

def filter_valid(sample):
    text = sample["text"]
    if not text:
        return False
    if not is_valid_text(text):
        return False
    if has_ngram_repeat(text, threshold=NGRAM_REPEAT_LIMIT):
        return False
    return True

# ==============================================
# PPL样本loss
# ==============================================
class PPLScorer:
    def __init__(self, tokenizer, model):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.tokenizer = tokenizer
        self.model = model.to(self.device)
        self.model.eval()

    @torch.no_grad()
    def ppl(self, text):
        inputs = self.tokenizer(
            text, return_tensors="pt", truncation=True, max_length=512
        ).to(self.device)
        loss = self.model(**inputs, labels=inputs["input_ids"]).loss
        return torch.exp(loss).item()

def sample_ppl_check(dataset, tokenizer, model):
    if tokenizer is None or model is None:
        return
    print("\n【抽样PPL质量检测】")
    scorer = PPLScorer(tokenizer, model)
    samples = random.sample(dataset["text"], 200)
    ppls = [scorer.ppl(s) for s in samples]
    print(ppls)
    avg = sum(ppls) / len(ppls)
    print(f"平均PPL: {avg:.2f}")
    return avg

def generate_quality_report(dataset, name="dataset"):
    print(f"\n====== 【数据质量报告：{name}】======")
    lengths = [len(s["text"]) for s in dataset]
    valid_texts = [s["text"] for s in dataset if is_valid_text(s["text"])]
    print(f"总样本数：{len(dataset)}")
    print(f"有效样本数：{len(valid_texts)}")
    print(f"平均长度：{np.mean(lengths):.1f}")
    print(f"长度中位数：{np.median(lengths):.1f}")
    print(f"有效字符比例阈值：{VALID_CHAR_THRESHOLD}")
    print("========================================\n")

# ==============================================
# 清洗数据调用API
# ==============================================
def clean_data(raw_data):
    print("开始清洗 text 字段...")
    # 1. 清洗文本（map）
    data_cleaned = raw_data.map(
        clean_sample,
        num_proc=8,
        desc="cleaning text"
    )

    # 2. 过滤低质量样本
    data_filtered = data_cleaned.filter(
        filter_valid,
        num_proc=8,
        desc="filtering bad samples"
    )
    cur_path = os.path.join(os.getcwd(),"id.txt")
    with open(cur_path, "w+") as f:
        f.write(str(ids))
    print(f"清洗完成！")
    print(f"清洗前：train={len(raw_data['train'])}, test={len(raw_data['test'])}")
    print(f"清洗后：train={len(data_filtered['train'])}, test={len(data_filtered['test'])}")
    # generate_quality_report(data_filtered['train'])
    return data_filtered

# ------------------------------------------------------------------------------
# 抽样测试ppl
# ------------------------------------------------------------------------------
def test():
    paths = get_data_paths("/mnt/build/llm_data")
    raw_datasets = datasets.load_dataset("json", data_files=paths["data_json"])
    raw_data = raw_datasets["train"].train_test_split(test_size=0.1, seed=2333)

    # 清洗！！！
    cleaned_data = clean_data(raw_data)
    # 抽样质检（可选）
    tokenizer = load_tokenizer(paths["tokenizer_dir"])
    config = Qwen2Config(
        vocab_size=len(tokenizer), hidden_size=512, intermediate_size=2048,
        num_attention_heads=8, num_hidden_layers=12, max_position_embeddings=1024,
        bos_token_id=tokenizer.bos_token_id, eos_token_id=tokenizer.eos_token_id
    )
    model = DecoderOnlyModel(config=config)
    sample_ppl_check(cleaned_data["train"], tokenizer, model)
