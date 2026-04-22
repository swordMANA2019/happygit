import argparse
import hashlib
import inspect
import json
import os
import re
import shutil
import traceback
import logging
from datetime import datetime
from enum import Enum

import datasets
import torch
import transformers
from transformers import AutoTokenizer, Qwen2Config



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
    parser.add_argument("--resume_weights_only", action="store_true", help="仅加载检查点模型权重继续训练（重置优化器和学习率调度）")
    parser.add_argument("--context_length", type=int, default=int(os.environ.get("PRETRAIN_CONTEXT_LENGTH", "512")), help="训练序列长度")
    parser.add_argument("--num_train_epochs", type=float, default=float(os.environ.get("PRETRAIN_NUM_TRAIN_EPOCHS", "4")), help="训练轮数")
    parser.add_argument("--learning_rate", type=float, default=float(os.environ.get("PRETRAIN_LEARNING_RATE", "5e-4")), help="学习率")
    parser.add_argument("--lr_scheduler_type", type=str, default=os.environ.get("PRETRAIN_LR_SCHEDULER_TYPE", "cosine_with_restarts"), help="学习率调度器")
    parser.add_argument("--warmup_ratio", type=float, default=float(os.environ.get("PRETRAIN_WARMUP_RATIO", "0.03")), help="warmup比例（0~1）")
    parser.add_argument("--eval_steps", type=int, default=int(os.environ.get("PRETRAIN_EVAL_STEPS", "50")), help="每多少步评估一次")
    parser.add_argument("--save_steps", type=int, default=int(os.environ.get("PRETRAIN_SAVE_STEPS", "100")), help="每多少步保存一次检查点")
    parser.add_argument("--max_grad_norm", type=float, default=float(os.environ.get("PRETRAIN_MAX_GRAD_NORM", "1.0")), help="梯度裁剪阈值")
    return parser.parse_args()

# ===================== 路径配置 =====================
MODEL_ID = os.environ.get("MODEL_ID", "Qwen/Qwen2-0.5B")
_TOKEN_CACHE_SCHEMA = "full_chunk_ctx_v2_quality"

_RE_WS = re.compile(r"\s+")
_RE_REPEAT_PUNC = re.compile(r"([，。！？,.!?；;：:])\1{3,}")
_PUNC_SET = set("，。！？,.!?；;：:")

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


def _normalize_text(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    t = _RE_WS.sub(" ", t)
    # 压缩超长连续标点，减少模型学到“标点刷屏”模式。
    t = _RE_REPEAT_PUNC.sub(lambda m: m.group(1) * 3, t)
    return t


def _punct_ratio(text: str) -> float:
    if not text:
        return 1.0
    p = sum(1 for ch in text if ch in _PUNC_SET)
    return p / len(text)


def _clean_and_filter_raw_data(raw_data: datasets.DatasetDict) -> datasets.DatasetDict:
    """轻量数据清洗：规范文本、过滤低质量样本、去重。"""
    min_chars = int(os.environ.get("PRETRAIN_MIN_TEXT_CHARS", "20"))
    max_punc_ratio = float(os.environ.get("PRETRAIN_MAX_PUNC_RATIO", "0.40"))

    cleaned = datasets.DatasetDict()
    for split_name in raw_data.keys():
        ds = raw_data[split_name]
        before_cnt = len(ds)

        def _normalize_batch(batch):
            return {"text": [_normalize_text(t) for t in batch["text"]]}

        ds = ds.map(_normalize_batch, batched=True)
        ds = ds.filter(lambda e: bool(e["text"]) and len(e["text"]) >= min_chars and _punct_ratio(e["text"]) <= max_punc_ratio)

        seen = set()

        def _not_dup(e):
            h = hashlib.sha1(e["text"].encode("utf-8")).hexdigest()
            if h in seen:
                return False
            seen.add(h)
            return True

        ds = ds.filter(_not_dup)
        after_cnt = len(ds)
        logger.info(
            f"数据清洗[{split_name}]：before={before_cnt}, after={after_cnt}, removed={before_cnt-after_cnt}, min_chars={min_chars}, max_punc_ratio={max_punc_ratio}"
        )
        cleaned[split_name] = ds
    return cleaned

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
        outputs = tokenizer(element["text"], truncation=True, max_length=context_length, return_overflowing_tokens=True, return_length=True)
        return {"input_ids": [ids for l, ids in zip(outputs["length"], outputs["input_ids"]) if l == context_length]}

    logger.info("正在处理数据...")
    os.makedirs(root, exist_ok=True)
    tokenized_datasets = raw_data.map(tokenize, batched=True, remove_columns=raw_data["train"].column_names)
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

def load_tokenizer(tokenizer_dir: str):
    os.makedirs(tokenizer_dir, exist_ok=True)
    try:
        if not os.listdir(tokenizer_dir):
            tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
            tokenizer.save_pretrained(tokenizer_dir)
        return AutoTokenizer.from_pretrained(tokenizer_dir, local_files_only=True)
    except Exception as e:
        logger.error(f"❌ Tokenizer加载失败：{e}")
        return None

# ===================== 主训练函数 =====================
class TrainExitState(str, Enum):
    COMPLETED = "completed"
    INTERRUPTED = "interrupted"
    FAILED = "failed"


def main():
    args = parse_args()
    paths = get_data_paths(args.data_dir)
    global logger
    logger = init_logger(paths["log_dir"])  # 初始化日志
    train_exit_state = None

    try:
        #swanlab.init("WikiLLM", logdir=os.path.join(paths["train_output"], "swanlog"))
        logger.info("开始训练任务...")

        # 加载数据
        raw_datasets = datasets.load_dataset("json", data_files=paths["data_json"])
        raw_data = raw_datasets["train"].train_test_split(test_size=0.1, seed=2333)
        raw_data = _clean_and_filter_raw_data(raw_data)
        logger.info(f"数据集加载完成：{raw_data}")

        # 加载Tokenizer
        tokenizer = load_tokenizer(paths["tokenizer_dir"])
        if not tokenizer:
            logger.error("❌ Tokenizer加载失败，程序退出")
            return

        # 处理数据集
        context_length = max(128, args.context_length)
        tokenized_datasets = _load_or_build_tokenized(paths["data_json"], paths["cache_root"], raw_data, tokenizer, context_length)
        tokenizer.pad_token = tokenizer.eos_token
        data_collator = transformers.DataCollatorForLanguageModeling(tokenizer, mlm=False)

        # 初始化模型
        config = Qwen2Config(
            vocab_size=len(tokenizer), hidden_size=512, intermediate_size=2048,
            num_attention_heads=8, num_hidden_layers=12, max_position_embeddings=context_length,
            bos_token_id=tokenizer.bos_token_id, eos_token_id=tokenizer.eos_token_id
        )
        model = DecoderOnlyModel(config=config, dropout=0.1)
        logger.info(f"模型参数量：{sum(p.numel() for p in model.parameters())/1e6:.1f}")

        # 精度配置
        _cuda = torch.cuda.is_available()
        use_bf16 = _cuda and torch.cuda.is_bf16_supported() and os.environ.get("PRETRAIN_USE_BF16", "") == "1"
        use_fp16 = _cuda and not use_bf16

        # Batch配置
        train_bs, eval_bs, grad_accum, vram_gb, _ = _choose_training_batch_hyperparams(
            args.train_batch_size, args.eval_batch_size, args.grad_accum
        )
        logger.info(f"Batch配置：train={train_bs}, eval={eval_bs}, grad_accum={grad_accum}")
        logger.info(f"有效batch（单卡）：effective_batch_size={train_bs * grad_accum}")
        logger.info(
            f"训练超参：context_length={context_length}, epochs={args.num_train_epochs}, lr={args.learning_rate}, "
            f"lr_scheduler={args.lr_scheduler_type}, warmup_ratio={args.warmup_ratio}, eval_steps={args.eval_steps}, save_steps={args.save_steps}"
        )

        # ===================== 训练参数（开启断点续训） =====================
        training_args = transformers.TrainingArguments(
            output_dir=paths["train_output"],
            per_device_train_batch_size=train_bs,
            per_device_eval_batch_size=eval_bs,
            gradient_accumulation_steps=grad_accum,
            eval_strategy="steps", eval_steps=max(1, args.eval_steps), logging_steps=max(10, min(50, args.eval_steps)),
            num_train_epochs=args.num_train_epochs, weight_decay=0.1, warmup_ratio=min(max(args.warmup_ratio, 0.0), 0.5),
            learning_rate=args.learning_rate, lr_scheduler_type=args.lr_scheduler_type, optim="adamw_torch",
            max_grad_norm=args.max_grad_norm,
            # 核心：开启检查点 + 禁用safetensors（解决权重共享报错）
            save_strategy="steps",      # 开启按步数保存
            save_steps=max(1, args.save_steps),
            save_safetensors=False,     # 禁用不兼容的safetensors（解决权重共享报错）
            save_only_model=False,      # 保存完整检查点（模型+优化器+训练状态）
            save_total_limit=3,         # 保留最新3个检查点
            bf16=use_bf16, fp16=use_fp16,
            dataloader_num_workers=2 if (_cuda and vram_gb>=6) else 0,
            dataloader_pin_memory=_cuda and vram_gb >= 6,
            load_best_model_at_end=True,
            metric_for_best_model="eval_loss",
            greater_is_better=False,
            logging_first_step=True,
        )

        # 初始化Trainer
        trainer = transformers.Trainer(
            model=model, args=training_args, data_collator=data_collator,
            train_dataset=tokenized_datasets["train"], eval_dataset=tokenized_datasets["test"],
            #callbacks=[SwanLabCallback()],
            tokenizer=tokenizer
        )

        # ===================== 自动断点续训 =====================
        logger.info(">>> 进入训练阶段")
        latest_ckpt = get_latest_checkpoint(paths["train_output"])
        if latest_ckpt:
            if args.resume_weights_only:
                logger.info(f"找到检查点，按仅权重模式加载：{latest_ckpt}")
                if load_model_weights(model, latest_ckpt):
                    logger.info("仅加载模型权重完成：优化器/学习率调度将重新开始")
                train_result = trainer.train()
            else:
                logger.info(f"找到检查点，从 {latest_ckpt} 继续训练")
                train_result = trainer.train(resume_from_checkpoint=latest_ckpt)
        else:
            # 无检查点则尝试加载手动保存的模型
            if load_model_weights(model, paths["model_weights"]):
                logger.info("从保存的模型权重开始训练")
            train_result = trainer.train()
        logger.info(f">>> 训练阶段完成（global_step={trainer.state.global_step}, loss={getattr(train_result, 'training_loss', 'N/A')}）")
        if trainer.state.best_metric is not None:
            logger.info(f">>> best_eval_loss={trainer.state.best_metric} @ {trainer.state.best_model_checkpoint}")

        # 保存最终模型
        _save_decoder_checkpoint(model, config, paths["model_weights"])

        # 生成测试
        logger.info(">>> 生成测试结果：")
        device = next(model.parameters()).device
        for prompt in ["人工智能", "牛顿", "北京市", "亚洲历史"]:
            res = _greedy_generate(model, tokenizer, prompt, device=device)
            logger.info(f"{prompt}: {res}")

        logger.info("训练任务完成！")
        train_exit_state = TrainExitState.COMPLETED

    except KeyboardInterrupt:
        train_exit_state = TrainExitState.INTERRUPTED
        logger.warning("训练被手动中断（KeyboardInterrupt）")
        raise
    except SystemExit as e:
        train_exit_state = TrainExitState.INTERRUPTED
        logger.warning(f"训练进程收到退出信号（SystemExit: code={e.code}）")
        raise
    except Exception as e:
        train_exit_state = TrainExitState.FAILED
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
    finally:
        if train_exit_state == TrainExitState.COMPLETED:
            logger.info(">>> 进程退出状态：训练完整结束，已完成生成测试")
        elif train_exit_state == TrainExitState.INTERRUPTED:
            logger.warning(">>> 进程退出状态：训练被中断，未完成完整收尾")
        elif train_exit_state == TrainExitState.FAILED:
            logger.critical(">>> 进程退出状态：训练异常失败，请查看 error_*.log")
        else:
            logger.warning(">>> 进程退出状态：训练未进入完整流程（早期退出）")

if __name__ == '__main__':
    main()