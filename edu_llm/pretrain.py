import argparse
import hashlib
import os
import traceback
import logging
from datetime import datetime

import datasets
import torch
import transformers
from transformers import Qwen2Config
import swanlab
from monitor import LayerMonitorCallback
from common import get_data_paths, load_tokenizer, MODEL_ID, clean_data


try:
    from swanlab.integration.transformers import SwanLabCallback
except ImportError:
    from swanlab.integration.huggingface import SwanLabCallback

from model import DecoderOnlyModel

# ===================== 全局日志配置 =====================
def init_logger(log_dir):
    """初始化日志系统：同时输出到文件和控制台"""
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, f"train_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
    
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        handlers=[
            logging.FileHandler(log_file, encoding="utf-8"),
            logging.StreamHandler()
        ]
    )
    return logging.getLogger(__name__)

# ===================== 命令行参数 =====================
def parse_args():
    parser = argparse.ArgumentParser(description="Decoder-Only LLM Pretraining Script")
    parser.add_argument("--data_dir", type=str, required=True, help="数据根目录")
    parser.add_argument("--train_batch_size", type=int, default=None, help="单卡训练batch size")
    parser.add_argument("--eval_batch_size", type=int, default=None, help="单卡验证batch size")
    parser.add_argument("--grad_accum", type=int, default=None, help="梯度累积步数")
    parser.add_argument("--num_epochs", type=int, default=10,
                        help="训练总轮数。2轮远不够收敛，建议至少10轮 (default: 10)")
    return parser.parse_args()

# ===================== 路径配置 =====================

_TOKEN_CACHE_SCHEMA = "full_chunk_ctx_v1"


# ===================== 断点续训核心（修复版） =====================
def is_checkpoint_valid(ckpt_dir):
    """校验检查点是否有效（必须包含核心文件）"""
    if not os.path.isdir(ckpt_dir):
        return False
    # 检查点必须包含的文件
    required_files = [
        "trainer_state.json",
        "pytorch_model.bin",
        "optimizer.pt"
    ]
    for f in required_files:
        if not os.path.exists(os.path.join(ckpt_dir, f)):
            return False
    return True

def get_latest_checkpoint(output_dir):
    """自动查找最新的有效检查点"""
    if not os.path.exists(output_dir):
        return None
    checkpoints = [d for d in os.listdir(output_dir) if d.startswith("checkpoint-")]
    if not checkpoints:
        return None
    
    # 按步数排序
    checkpoints.sort(key=lambda x: int(x.split("-")[1]), reverse=True)
    # 遍历查找第一个有效的检查点
    for ckpt in checkpoints:
        ckpt_path = os.path.join(output_dir, ckpt)
        if is_checkpoint_valid(ckpt_path):
            return ckpt_path
    return None

def load_model_weights(model, weight_dir):
    """从保存的权重加载模型"""
    weight_path = os.path.join(weight_dir, "pytorch_model.bin")
    if os.path.exists(weight_path):
        model.load_state_dict(torch.load(weight_path, map_location="cpu"))
        logger.info(f"✅ 成功加载模型权重：{weight_path}")
        return True
    return False

# ===================== 训练参数适配 =====================
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

    # 优先级：命令行 > 环境变量 > 自动适配
    if cmd_train_bs is not None:
        train_bs = max(1, cmd_train_bs)
    elif e_bs:
        train_bs = max(1, int(e_bs))
    elif not torch.cuda.is_available():
        train_bs = 2
    else:
        train_bs = 1 if total_gb < 3 else 2 if total_gb < 6 else 4 if total_gb < 12 else 8 if total_gb < 24 else 16

    if cmd_eval_bs is not None:
        eval_bs = max(1, cmd_eval_bs)
    elif e_ev:
        eval_bs = max(1, int(e_ev))
    elif not torch.cuda.is_available():
        eval_bs = train_bs
    else:
        eval_bs = 1 if total_gb < 6 else min(train_bs, 8)

    if cmd_grad_accum is not None:
        grad_accum = max(1, cmd_grad_accum)
    elif e_ga:
        grad_accum = max(1, int(e_ga))
    else:
        grad_accum = max(1, (target_eff + train_bs - 1) // train_bs)

    return train_bs, eval_bs, grad_accum, total_gb, dev_name

# ===================== 数据集处理 =====================
def _data_mtime_ns(st: os.stat_result) -> int:
    return int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))

def _token_cache_fingerprint(data_json: str, context_length: int, model_id: str, test_size: float, seed: int) -> str:
    p = os.path.abspath(os.path.expanduser(data_json))
    st = os.stat(p)
    key = "|".join([_TOKEN_CACHE_SCHEMA, p, str(st.st_size), str(_data_mtime_ns(st)), str(context_length), model_id, str(test_size), str(seed)])
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]

def _load_or_build_tokenized(data_json: str, cache_root: str, raw_data, tokenizer, context_length: int) -> datasets.DatasetDict:
    test_size = 0.1
    seed = 2333
    fp = _token_cache_fingerprint(data_json, context_length, MODEL_ID, test_size, seed)
    root = os.path.join(cache_root, "pretrain_token_cache", fp)
    ds_path = os.path.join(root, "dataset")
    meta_path = os.path.join(root, "meta.json")

    use_cache = os.environ.get("PRETRAIN_TOKEN_CACHE", "1").lower() not in ("0", "false")
    rebuild = os.environ.get("PRETRAIN_REBUILD_TOKEN_CACHE", "").lower() in ("1", "true")

    if use_cache and not rebuild and os.path.isdir(ds_path):
        try:
            logger.info(f"✅ 从缓存加载数据集：{ds_path}")
            return datasets.load_from_disk(ds_path)
        except Exception as e:
            logger.warning(f"缓存加载失败，重新处理数据：{e}")

    def tokenize(element):
        # Append EOS to each article so the model learns document boundaries.
        # Without this, chunks from different articles are indistinguishable and
        # the model learns false cross-document continuity.
        texts_with_eos = [t + tokenizer.eos_token for t in element["text"]]
        outputs = tokenizer(texts_with_eos, truncation=True, max_length=context_length, return_overflowing_tokens=True, return_length=True)
        return {"input_ids": [ids for l, ids in zip(outputs["length"], outputs["input_ids"]) if l == context_length]}

    logger.info("正在处理数据...")
    os.makedirs(root, exist_ok=True)
    tokenized_datasets = raw_data.map(tokenize, batched=True,
                                      remove_columns=raw_data["train"].column_names)
    if use_cache:
        tokenized_datasets.save_to_disk(ds_path)
    return tokenized_datasets

# ===================== 模型工具 =====================
def _save_decoder_checkpoint(model: DecoderOnlyModel, config, out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    torch.save(model.state_dict(), os.path.join(out_dir, "pytorch_model.bin"))
    config.save_pretrained(out_dir)
    logger.info(f"✅ 模型已保存至：{out_dir}")

@torch.no_grad()
def _greedy_generate(model, tokenizer, prompt: str, max_new_tokens=64, device=None):
    model.eval()
    device = device or next(model.parameters()).device
    input_ids = torch.tensor([tokenizer.encode(prompt) or [tokenizer.eos_token_id]], device=device)
    eos = tokenizer.eos_token_id
    for _ in range(max_new_tokens):
        next_id = model(input_ids).logits[0, -1].argmax()
        input_ids = torch.cat([input_ids, next_id.unsqueeze(0).unsqueeze(0)], dim=1)
        if next_id == eos:
            break
    return tokenizer.decode(input_ids[0], skip_special_tokens=True)



# ===================== 主训练函数 =====================
def main():
    args = parse_args()
    paths = get_data_paths(args.data_dir)
    global logger
    logger = init_logger(paths["log_dir"])  # 初始化日志

    try:
        swanlab.init("WikiLLM", logdir=os.path.join(paths["train_output"], "swanlog"))
        logger.info("开始训练任务...")

        # 加载数据
        raw_datasets = datasets.load_dataset("json", data_files=paths["data_json"])
        raw_data = raw_datasets["train"].train_test_split(test_size=0.1, seed=2333)
        # logger.info(f"数据集加载完成：{raw_data}")
        raw_data = clean_data(raw_data)
        # logger.info(f"加载清洗后的数据：{raw_data}")
        # 加载Tokenizer
        tokenizer = load_tokenizer(paths["tokenizer_dir"])
        if not tokenizer:
            logger.error("❌ Tokenizer加载失败，程序退出")
            return

        # Add a dedicated pad token so that DataCollatorForLanguageModeling can
        # mask pad positions with label=-100 without accidentally masking EOS
        # tokens (which carry the "stop generating" supervision signal).
        if tokenizer.pad_token is None or tokenizer.pad_token_id == tokenizer.eos_token_id:
            tokenizer.add_special_tokens({"pad_token": "<|pad|>"})
            logger.info(f"新增独立 pad_token: id={tokenizer.pad_token_id}")

        # 处理数据集（tokenizer已固定，在tokenize之前确定pad_token）
        tokenized_datasets = _load_or_build_tokenized(
            paths["data_json"], paths["cache_root"], raw_data, tokenizer, 512)
        data_collator = transformers.DataCollatorForLanguageModeling(tokenizer, mlm=False)

        # 初始化模型（vocab_size已包含新增的pad token）
        config = Qwen2Config(
            vocab_size=len(tokenizer), hidden_size=512, intermediate_size=2048,
            num_attention_heads=8, num_hidden_layers=12, max_position_embeddings=1024,
            bos_token_id=tokenizer.bos_token_id, eos_token_id=tokenizer.eos_token_id,
            pad_token_id=tokenizer.pad_token_id,
        )
        model = DecoderOnlyModel(config=config, dropout=0.1)
        logger.info(f"模型参数量：{sum(p.numel() for p in model.parameters())/1e6:.1f}")

        # 精度配置
        _cuda = torch.cuda.is_available()
        use_bf16 = (_cuda and torch.cuda.is_bf16_supported()
                    and os.environ.get("PRETRAIN_USE_BF16", "") == "1")
        use_fp16 = _cuda and not use_bf16

        # Batch配置
        train_bs, eval_bs, grad_accum, vram_gb, _ = _choose_training_batch_hyperparams(
            args.train_batch_size, args.eval_batch_size, args.grad_accum
        )
        logger.info(f"Batch配置：train={train_bs}, eval={eval_bs}, grad_accum={grad_accum}")

        # ===================== 训练参数（开启断点续训） =====================
        training_args = transformers.TrainingArguments(
            output_dir=paths["train_output"],
            per_device_train_batch_size=train_bs,
            per_device_eval_batch_size=eval_bs,
            gradient_accumulation_steps=grad_accum,
            eval_strategy="steps", eval_steps=500, logging_steps=50,
            num_train_epochs=args.num_epochs,   # was hard-coded to 2; 2 epochs
                                                # is far from convergence — use
                                                # --num_epochs to control (default 10)
            weight_decay=0.1,
            warmup_steps=500,                   # was 200; with proper embedding
                                                # init the model still benefits
                                                # from a longer ramp to peak LR
                                                # to absorb large initial updates
            learning_rate=5e-4, lr_scheduler_type="cosine", optim="adamw_torch",
            max_grad_norm=1.0,                  # explicit gradient clipping;
                                                # dampens outlier-batch spikes
            # 核心：开启检查点 + 禁用safetensors（解决权重共享报错）
            save_strategy="steps",      # 开启按步数保存
            save_steps=100,             # 每100步生成检查点（快速生效）
            save_safetensors=False,     # 禁用不兼容的safetensors（解决权重共享报错）
            save_only_model=False,      # 保存完整检查点（模型+优化器+训练状态）
            save_total_limit=3,         # 保留最新3个检查点
            bf16=use_bf16, fp16=use_fp16,
            dataloader_num_workers=2 if (_cuda and vram_gb>=6) else 0,
            dataloader_pin_memory=_cuda and vram_gb >= 6,
        )

        # 初始化Trainer
        trainer = transformers.Trainer(
            model=model, args=training_args, data_collator=data_collator,
            train_dataset=tokenized_datasets["train"], eval_dataset=tokenized_datasets["test"],
            callbacks=[SwanLabCallback(),LayerMonitorCallback()], tokenizer=tokenizer
        )

        # ===================== 自动断点续训 =====================
        latest_ckpt = get_latest_checkpoint(paths["train_output"])
        if latest_ckpt:
            logger.info(f"找到检查点，从 {latest_ckpt} 继续训练")
            trainer.train(resume_from_checkpoint=latest_ckpt)
        else:
            # 无检查点则尝试加载手动保存的模型
            if load_model_weights(model, paths["model_weights"]):
                logger.info("从保存的模型权重开始训练")
            trainer.train()

        # 保存最终模型
        _save_decoder_checkpoint(model, config, paths["model_weights"])

        # 生成测试
        # Use model.generate() (with repetition penalty + sampling) so the test
        # reflects the same decoding path that real inference uses.  The old
        # _greedy_generate() did pure argmax and had no repetition penalty,
        # causing the model to loop on "，，，，，" even when it had learned
        # meaningful token distributions.
        logger.info("\n 生成测试结果：")
        device = next(model.parameters()).device
        model.eval()
        for prompt in ["人工智能", "牛顿", "北京市", "亚洲历史"]:
            input_ids = torch.tensor(
                [tokenizer.encode(prompt) or [tokenizer.eos_token_id]],
                device=device,
            )
            out_ids = model.generate(
                input_ids,
                max_new_tokens=100,
                temperature=0.8,
                top_p=0.9,
                repetition_penalty=1.3,
                do_sample=True,
                eos_token_id=tokenizer.eos_token_id,
                pad_token_id=tokenizer.pad_token_id,
            )
            res = tokenizer.decode(out_ids[0], skip_special_tokens=True)
            logger.info(f"{prompt}: {res}")

        logger.info("训练任务完成！")

    except Exception as e:
        # ===================== 异常捕获：保存堆栈 =====================
        error_msg = f"训练异常中断：{str(e)}"
        stack_msg = traceback.format_exc()
        logger.critical(error_msg)
        logger.critical(f"异常堆栈：\n{stack_msg}")
        
        # 保存异常到单独文件
        error_file = os.path.join(paths["log_dir"], f"error_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
        with open(error_file, "w", encoding="utf-8") as f:
            f.write(error_msg + "\n" + stack_msg)
        raise  # 抛出异常便于查看

if __name__ == '__main__':
    main()