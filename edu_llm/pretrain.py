import argparse
import hashlib
import inspect
import json
import os
import shutil

import datasets
import torch
import transformers
from transformers import AutoTokenizer, Qwen2Config
import swanlab

try:
    from swanlab.integration.transformers import SwanLabCallback
except ImportError:
    from swanlab.integration.huggingface import SwanLabCallback

from model import DecoderOnlyModel

# 命令行参数解析
def parse_args():
    parser = argparse.ArgumentParser(description="Decoder-Only LLM Pretraining Script")
    # 唯一必填参数：数据根目录
    parser.add_argument(
        "--data_dir", 
        type=str, 
        required=True, 
        help="Root directory for all data (json, tokenizer, cache)"
    )
    # 可选参数：手动指定batch size（不填则自动适配GPU）
    parser.add_argument(
        "--train_batch_size", 
        type=int, 
        default=None, 
        help="Per device train batch size (auto if not set)"
    )
    parser.add_argument(
        "--eval_batch_size", 
        type=int, 
        default=None, 
        help="Per device eval batch size (auto if not set)"
    )
    parser.add_argument(
        "--grad_accum", 
        type=int, 
        default=None, 
        help="Gradient accumulation steps (auto if not set)"
    )
    return parser.parse_args()

MODEL_ID = os.environ.get("MODEL_ID", "Qwen/Qwen2-0.5B")
_TOKEN_CACHE_SCHEMA = "full_chunk_ctx_v1"

# ===================== 自动路径生成函数 =====================
def get_data_paths(data_dir: str):
    """自动生成所有数据路径（基于根目录）"""
    return {
        "data_json": os.path.join(data_dir, "wikipedia-zh-cn-20240820.json"),
        "tokenizer_dir": os.path.join(data_dir, "tokenizer"),
        "cache_root": data_dir,  # 缓存根目录
    }
# ==========================================================

# 自动适配batch size（优先命令行参数）
def _choose_training_batch_hyperparams(cmd_train_bs=None, cmd_eval_bs=None, cmd_grad_accum=None):
    target_eff = int(os.environ.get("PRETRAIN_TARGET_EFFECTIVE_BATCH", "128"))
    e_bs = os.environ.get("PRETRAIN_PER_DEVICE_TRAIN_BATCH_SIZE", "").strip()
    e_ev = os.environ.get("PRETRAIN_PER_DEVICE_EVAL_BATCH_SIZE", "").strip()
    e_ga = os.environ.get("PRETRAIN_GRADIENT_ACCUMULATION_STEPS", "").strip()

    total_gb = 0.0
    dev_name = ""
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        total_gb = props.total_memory / (1024**3)
        dev_name = props.name

    # 优先级：命令行参数 > 环境变量 > 自动适配
    if cmd_train_bs is not None:
        train_bs = max(1, cmd_train_bs)
    elif e_bs:
        train_bs = max(1, int(e_bs))
    elif not torch.cuda.is_available():
        train_bs = 2
    else:
        if total_gb < 3.0:
            train_bs = 1
        elif total_gb < 6.0:
            train_bs = 2
        elif total_gb < 12.0:
            train_bs = 4
        elif total_gb < 24.0:
            train_bs = 8
        else:
            train_bs = 16

    if cmd_eval_bs is not None:
        eval_bs = max(1, cmd_eval_bs)
    elif e_ev:
        eval_bs = max(1, int(e_ev))
    elif not torch.cuda.is_available():
        eval_bs = train_bs
    elif total_gb < 6.0:
        eval_bs = 1
    else:
        eval_bs = min(train_bs, 8)

    if cmd_grad_accum is not None:
        grad_accum = max(1, cmd_grad_accum)
    elif e_ga:
        grad_accum = max(1, int(e_ga))
    else:
        grad_accum = max(1, (target_eff + train_bs - 1) // train_bs)

    return train_bs, eval_bs, grad_accum, total_gb, dev_name

def _data_mtime_ns(st: os.stat_result) -> int:
    return int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))

def _token_cache_fingerprint(
    data_json: str, context_length: int, model_id: str, test_size: float, seed: int
) -> str:
    p = os.path.abspath(os.path.expanduser(data_json))
    st = os.stat(p)
    key = "|".join(
        [
            _TOKEN_CACHE_SCHEMA,
            p,
            str(st.st_size),
            str(_data_mtime_ns(st)),
            str(context_length),
            model_id,
            str(test_size),
            str(seed),
        ]
    )
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]

def _token_cache_meta(
    data_json: str, context_length: int, model_id: str, test_size: float, seed: int
) -> dict:
    p = os.path.abspath(os.path.expanduser(data_json))
    st = os.stat(p)
    return {
        "schema": _TOKEN_CACHE_SCHEMA,
        "data_json": p,
        "data_size": st.st_size,
        "data_mtime_ns": _data_mtime_ns(st),
        "context_length": context_length,
        "model_id": model_id,
        "test_size": test_size,
        "seed": seed,
    }

# 加载/构建tokenized数据集（自动使用根目录缓存）
def _load_or_build_tokenized(
    data_json: str, cache_root: str, raw_data, tokenizer, context_length: int
) -> datasets.DatasetDict:
    test_size = 0.1
    seed = 2333
    fp = _token_cache_fingerprint(data_json, context_length, MODEL_ID, test_size, seed)
    root = os.path.join(cache_root, "pretrain_token_cache", fp)
    ds_path = os.path.join(root, "dataset")
    meta_path = os.path.join(root, "meta.json")

    use_cache = os.environ.get("PRETRAIN_TOKEN_CACHE", "1").strip().lower() not in ("0", "false", "no", "off")
    rebuild = os.environ.get("PRETRAIN_REBUILD_TOKEN_CACHE", "").strip().lower() in ("1", "true", "yes")
    meta = _token_cache_meta(data_json, context_length, MODEL_ID, test_size, seed)

    if use_cache and not rebuild and os.path.isdir(ds_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                disk_meta = json.load(f)
            if disk_meta == meta:
                print(f"Loading tokenized dataset from cache: {ds_path}", flush=True)
                return datasets.load_from_disk(ds_path)
            print("Token cache mismatch; remapping…", flush=True)
        except Exception as e:
            print(f"Token cache unreadable ({e}); remapping…", flush=True)

    def tokenize(element):
        outputs = tokenizer(
            element["text"],
            truncation=True,
            max_length=context_length,
            return_overflowing_tokens=True,
            return_length=True,
        )
        input_batch = []
        for length, input_ids in zip(outputs["length"], outputs["input_ids"]):
            if length == context_length:
                input_batch.append(input_ids)
        return {"input_ids": input_batch}

    print("Tokenizing dataset…", flush=True)
    os.makedirs(root, exist_ok=True)
    tokenized_datasets = raw_data.map(tokenize, batched=True, remove_columns=raw_data["train"].column_names)
    
    if use_cache:
        if os.path.isdir(ds_path):
            shutil.rmtree(ds_path)
        tokenized_datasets.save_to_disk(ds_path)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        print(f"Saved token dataset to: {ds_path}", flush=True)
    return tokenized_datasets

def _save_decoder_checkpoint(model: DecoderOnlyModel, config, out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    torch.save(model.state_dict(), os.path.join(out_dir, "pytorch_model.bin"))
    config.save_pretrained(out_dir)

@torch.no_grad()
def _greedy_generate(model, tokenizer, prompt: str, max_new_tokens: int = 64, device=None):
    model.eval()
    if device is None:
        device = next(model.parameters()).device
    ids = tokenizer.encode(prompt, add_special_tokens=False)
    if not ids:
        ids = [tokenizer.eos_token_id or 0]
    input_ids = torch.tensor([ids], dtype=torch.long, device=device)
    eos = tokenizer.eos_token_id
    for _ in range(max_new_tokens):
        out = model(input_ids=input_ids)
        next_id = int(out.logits[0, -1, :].argmax().item())
        input_ids = torch.cat([input_ids, torch.tensor([[next_id]], device=device)], dim=1)
        if eos is not None and next_id == eos:
            break
    return tokenizer.decode(input_ids[0].tolist(), skip_special_tokens=True)

# 自动加载tokenizer（根目录下）
def load_tokenizer(tokenizer_dir: str):
    os.makedirs(tokenizer_dir, exist_ok=True)
    if not os.listdir(tokenizer_dir):
        try:
            tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
            tokenizer.save_pretrained(tokenizer_dir)
            return tokenizer
        except Exception as e:
            print(f"Download tokenizer failed: {e}")
            return None
    else:
        try:
            return AutoTokenizer.from_pretrained(tokenizer_dir, local_files_only=True)
        except Exception as e:
            print(f"Load local tokenizer failed: {e}")
    return None

def main():
    args = parse_args()
    # 自动生成所有数据路径
    paths = get_data_paths(args.data_dir)
    swanlab.init("WikiLLM")

    # 1. 加载训练数据（根目录下自动读取）
    raw_datasets = datasets.load_dataset("json", data_files=paths["data_json"])
    raw_data = raw_datasets["train"].train_test_split(test_size=0.1, seed=2333)
    print("=== Dataset Info ===")
    print(raw_data)

    context_length = 512
    # 2. 加载tokenizer（根目录下自动保存/加载）
    tokenizer = load_tokenizer(paths["tokenizer_dir"])
    if tokenizer is None:
        return
    
    # 3. 加载/构建数据集缓存（根目录下自动管理）
    tokenized_datasets = _load_or_build_tokenized(
        paths["data_json"], paths["cache_root"], raw_data, tokenizer, context_length
    )

    # 裁剪数据集（可选）
    _mx = os.environ.get("PRETRAIN_MAX_TRAIN_SAMPLES", "").strip()
    if _mx: tokenized_datasets["train"] = tokenized_datasets["train"].select(range(int(_mx)))
    _mx = os.environ.get("PRETRAIN_MAX_EVAL_SAMPLES", "").strip()
    if _mx: tokenized_datasets["test"] = tokenized_datasets["test"].select(range(int(_mx)))
    
    print("=== Tokenized Dataset Info ===")
    print(tokenized_datasets)
    tokenizer.pad_token = tokenizer.eos_token
    data_collator = transformers.DataCollatorForLanguageModeling(tokenizer, mlm=False)

    # 模型配置
    config = Qwen2Config(
        vocab_size=len(tokenizer),
        hidden_size=512,
        intermediate_size=2048,
        num_attention_heads=8,
        num_hidden_layers=12,
        max_position_embeddings=1024,
        bos_token_id=tokenizer.bos_token_id,
        eos_token_id=tokenizer.eos_token_id
    )
    model = DecoderOnlyModel(config=config, dropout=0.1)
    model_size = sum(t.numel() for t in model.parameters())
    print(f"=== Model Size: {model_size/1000**2:.1f}M parameters ===")

    # 精度设置
    _cuda = torch.cuda.is_available()
    _bf16_ok = _cuda and torch.cuda.is_bf16_supported()
    use_bf16 = os.environ.get("PRETRAIN_USE_BF16", "") in ("1", "true") and _bf16_ok
    use_fp16 = not use_bf16 and _cuda
    if os.environ.get("PRETRAIN_USE_FP32", "") in ("1", "true"):
        use_bf16, use_fp16 = False, False

    # 批量大小配置
    train_bs, eval_bs, grad_accum, vram_gb, dev_name = _choose_training_batch_hyperparams(
        args.train_batch_size, args.eval_batch_size, args.grad_accum
    )
    print(f"Batch Config: train={train_bs}, eval={eval_bs}, grad_accum={grad_accum}")

    # 数据加载器配置
    num_workers = int(os.environ.get("PRETRAIN_DATALOADER_WORKERS", 2 if (_cuda and vram_gb>=6) else 0))
    
    # 训练参数
    training_args = transformers.TrainingArguments(
        output_dir=os.path.join(args.data_dir, "train_output"),
        per_device_train_batch_size=train_bs,
        per_device_eval_batch_size=eval_bs,
        gradient_accumulation_steps=grad_accum,
        eval_strategy="steps", eval_steps=500, logging_steps=50,
        num_train_epochs=2, weight_decay=0.1, warmup_steps=200,
        learning_rate=5e-4, lr_scheduler_type="cosine", optim="adamw_torch",
        save_steps=500, save_total_limit=10,
        bf16=use_bf16, fp16=use_fp16,
        dataloader_num_workers=num_workers,
        dataloader_pin_memory=_cuda and vram_gb >= 6,
    )

    # 训练
    trainer = transformers.Trainer(
        model=model,
        args=training_args,
        data_collator=data_collator,
        train_dataset=tokenized_datasets["train"],
        eval_dataset=tokenized_datasets["test"],
        callbacks=[SwanLabCallback()],
        tokenizer=tokenizer,
    )
    trainer.train()

    # 保存模型（根目录下）
    weight_dir = os.path.join(args.data_dir, "model_weights")
    _save_decoder_checkpoint(model, config, weight_dir)
    print(f"Model saved to: {weight_dir}")

    # 生成测试
    device = next(model.parameters()).device
    print("\n=== Generation Test ===")
    print(_greedy_generate(model, tokenizer, "人工智能", device=device))
    for p in ["牛顿", "北京市", "亚洲历史"]:
        print(_greedy_generate(model, tokenizer, p, device=device))

if __name__ == '__main__':
    main()