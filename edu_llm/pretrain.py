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

MODEL_ID = os.environ.get("MODEL_ID", "Qwen/Qwen2-0.5B")

_DATA_JSON = os.environ.get(
    "PRETRAIN_DATA_JSON",
    "/mnt/build/llm_data/wikipedia-zh-cn-20240820.json",
)


def _choose_training_batch_hyperparams():
    """Pick batch sizes and grad accumulation from GPU VRAM to avoid CUDA OOM.

    Override: PRETRAIN_PER_DEVICE_TRAIN_BATCH_SIZE, PRETRAIN_PER_DEVICE_EVAL_BATCH_SIZE,
    PRETRAIN_GRADIENT_ACCUMULATION_STEPS, PRETRAIN_TARGET_EFFECTIVE_BATCH (default 128).
    """
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

    if e_bs:
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

    if e_ev:
        eval_bs = max(1, int(e_ev))
    elif not torch.cuda.is_available():
        eval_bs = train_bs
    elif total_gb < 6.0:
        eval_bs = 1
    else:
        eval_bs = min(train_bs, 8)

    if e_ga:
        grad_accum = max(1, int(e_ga))
    else:
        grad_accum = max(1, (target_eff + train_bs - 1) // train_bs)

    return train_bs, eval_bs, grad_accum, total_gb, dev_name


# Tokenized DatasetDict cache (train/test splits, fixed-length chunks).
# Set PRETRAIN_REBUILD_TOKEN_CACHE=1 to ignore cache and remap.
# Set PRETRAIN_TOKEN_CACHE=0 to disable read/write cache for this run.
_TOKEN_CACHE_SCHEMA = "full_chunk_ctx_v1"  # bump if tokenize() logic changes


def _token_cache_root() -> str:
    return os.environ.get(
        "PRETRAIN_TOKEN_CACHE_ROOT",
        os.environ.get("LLM_DATA_ROOT", "/mnt/build/llm_data"),
    )


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


def _load_or_build_tokenized(raw_data, tokenizer, context_length: int) -> datasets.DatasetDict:
    test_size = 0.1
    seed = 2333
    fp = _token_cache_fingerprint(_DATA_JSON, context_length, MODEL_ID, test_size, seed)
    root = os.path.join(_token_cache_root(), "pretrain_token_cache", fp)
    ds_path = os.path.join(root, "dataset")
    meta_path = os.path.join(root, "meta.json")

    use_cache = os.environ.get("PRETRAIN_TOKEN_CACHE", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )
    rebuild = os.environ.get("PRETRAIN_REBUILD_TOKEN_CACHE", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )

    meta = _token_cache_meta(_DATA_JSON, context_length, MODEL_ID, test_size, seed)

    if use_cache and not rebuild and os.path.isdir(ds_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                disk_meta = json.load(f)
            if disk_meta == meta:
                print(f"Loading tokenized dataset from cache: {ds_path}", flush=True)
                return datasets.load_from_disk(ds_path)
            print(
                "Token cache fingerprint mismatch (data or settings changed); remapping…",
                flush=True,
            )
        except (OSError, json.JSONDecodeError, TypeError) as e:
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

    print("Tokenizing dataset (first run or cache miss; this can take a long time)…", flush=True)
    os.makedirs(root, exist_ok=True)
    tokenized_datasets = raw_data.map(
        tokenize, batched=True, remove_columns=raw_data["train"].column_names
    )
    if use_cache:
        if os.path.isdir(ds_path):
            shutil.rmtree(ds_path)
        tokenized_datasets.save_to_disk(ds_path)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        print(f"Saved tokenized dataset to: {ds_path}", flush=True)
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
        input_ids = torch.cat(
            [input_ids, torch.tensor([[next_id]], dtype=torch.long, device=device)], dim=1
        )
        if eos is not None and next_id == eos:
            break
    return tokenizer.decode(input_ids[0].tolist(), skip_special_tokens=True)


def main():
    # using swanlab to save log
    swanlab.init("WikiLLM")
    # load dataset — must tokenize the same split used for train/eval
    raw_datasets = datasets.load_dataset("json", data_files=_DATA_JSON)
    raw_data = raw_datasets["train"].train_test_split(test_size=0.1, seed=2333)
    print("dataset info")
    print(raw_data)

    context_length = 512  # use a small context length
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)

    tokenized_datasets = _load_or_build_tokenized(raw_data, tokenizer, context_length)
    _mx = os.environ.get("PRETRAIN_MAX_TRAIN_SAMPLES", "").strip()
    if _mx:
        _n = int(_mx)
        tokenized_datasets["train"] = tokenized_datasets["train"].select(
            range(min(_n, len(tokenized_datasets["train"])))
        )
    _mx = os.environ.get("PRETRAIN_MAX_EVAL_SAMPLES", "").strip()
    if _mx:
        _n = int(_mx)
        tokenized_datasets["test"] = tokenized_datasets["test"].select(
            range(min(_n, len(tokenized_datasets["test"])))
        )
    print("tokenize dataset info")
    print(tokenized_datasets)
    tokenizer.pad_token = tokenizer.eos_token
    data_collator = transformers.DataCollatorForLanguageModeling(tokenizer, mlm=False)

    config = Qwen2Config.from_pretrained(
        MODEL_ID,
        vocab_size=len(tokenizer),
        hidden_size=512,
        intermediate_size=2048,
        num_attention_heads=8,
        num_hidden_layers=12,
        max_position_embeddings=1024,
        bos_token_id=tokenizer.bos_token_id,
        eos_token_id=tokenizer.eos_token_id
    )
    # print(f"config:{config}")
    model = DecoderOnlyModel(config=config, dropout=0.1)

    model_size = sum(t.numel() for t in model.parameters())
    print("Model Config:")
    print(config)
    print(f"Model Size: {model_size/1000**2:.1f}M parameters")

    # Precision: torch.nn.MultiheadAttention under bf16 can raise
    # CUBLAS_STATUS_NOT_SUPPORTED on some GPUs/drivers. Default to fp16 on CUDA, fp32 on CPU.
    # Set PRETRAIN_USE_BF16=1 to force bf16 (if your stack supports it).
    _cuda = torch.cuda.is_available()
    _bf16_ok = _cuda and getattr(torch.cuda, "is_bf16_supported", lambda: False)()
    _force_bf16 = os.environ.get("PRETRAIN_USE_BF16", "").strip().lower() in ("1", "true", "yes")
    _force_fp32 = os.environ.get("PRETRAIN_USE_FP32", "").strip().lower() in ("1", "true", "yes")
    if _force_fp32:
        use_bf16, use_fp16 = False, False
    elif _force_bf16 and _bf16_ok:
        use_bf16, use_fp16 = True, False
    else:
        use_bf16, use_fp16 = False, _cuda

    train_bs, eval_bs, grad_accum, vram_gb, dev_name = _choose_training_batch_hyperparams()
    if torch.cuda.is_available():
        print(
            f"GPU {dev_name}: ~{vram_gb:.2f} GiB — "
            f"per_device_train_batch_size={train_bs}, "
            f"per_device_eval_batch_size={eval_bs}, "
            f"gradient_accumulation_steps={grad_accum}",
            flush=True,
        )
    else:
        print(
            f"CPU run — train_bs={train_bs}, eval_bs={eval_bs}, grad_accum={grad_accum}",
            flush=True,
        )

    # train
    _dl_workers = os.environ.get("PRETRAIN_DATALOADER_WORKERS", "").strip()
    if _dl_workers != "":
        dataloader_num_workers = max(0, int(_dl_workers))
    elif torch.cuda.is_available() and vram_gb < 6.0:
        dataloader_num_workers = 0
    else:
        dataloader_num_workers = 2

    args = transformers.TrainingArguments(
        output_dir="data",
        per_device_train_batch_size=train_bs,
        per_device_eval_batch_size=eval_bs,
        eval_strategy="steps",
        eval_steps=5_00,
        logging_steps=50,
        gradient_accumulation_steps=grad_accum,
        num_train_epochs=2,  # 训练epoch数
        weight_decay=0.1,
        warmup_steps=2_00,
        optim="adamw_torch",  # 优化器使用adamw
        lr_scheduler_type="cosine",  # 学习率衰减策略
        learning_rate=5e-4,  # 基础学习率，
        save_steps=5_00,
        save_total_limit=10,
        bf16=use_bf16,
        fp16=use_fp16,
        dataloader_num_workers=dataloader_num_workers,
        dataloader_pin_memory=torch.cuda.is_available() and vram_gb >= 6.0,
    )
    print(
        f"Train precision: bf16={use_bf16} fp16={use_fp16} "
        f"(override: PRETRAIN_USE_BF16=1 or PRETRAIN_USE_FP32=1)"
    )
    print("Train Args:")
    print(args)
    # enjoy training
    _trainer_kw = dict(
        model=model,
        args=args,
        data_collator=data_collator,
        train_dataset=tokenized_datasets["train"],
        eval_dataset=tokenized_datasets["test"],
        callbacks=[SwanLabCallback()],
    )
    if "processing_class" in inspect.signature(transformers.Trainer.__init__).parameters:
        _trainer_kw["processing_class"] = tokenizer
    else:
        _trainer_kw["tokenizer"] = tokenizer
    trainer = transformers.Trainer(**_trainer_kw)
    trainer.train()
    # Custom nn.Module: save weights + HF config (no model.save_pretrained)
    weight_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "Weight")
    _save_decoder_checkpoint(model, config, weight_dir)

    device = next(model.parameters()).device
    gen1 = _greedy_generate(model, tokenizer, "人工智能", max_new_tokens=64, device=device)
    print("GENERATE:", gen1)
    prompts = ["牛顿", "北京市", "亚洲历史"]
    examples = []
    for p in prompts:
        text = _greedy_generate(model, tokenizer, p, max_new_tokens=64, device=device)
        examples.append(swanlab.Text(text))
    swanlab.log({"Generate": examples})

if __name__ == '__main__':
    main()