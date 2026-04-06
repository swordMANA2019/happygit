import os
import json
import torch
from datasets import Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    TrainingArguments,
    Trainer,
    DataCollatorForLanguageModeling
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
import bitsandbytes as bnb

# ====================== 1. 全局配置（直接改这里）======================
MODEL_PATH = "你的基座模型路径"  # 例如：./base_model (你用Wikipedia预训练完的模型)
TRAIN_FILE = "sft_zhwiki.jsonl"  # 刚才生成的SFT数据
OUTPUT_DIR = "./sft_lora_model"  # 训练完LoRA权重保存路径
MAX_SEQ_LEN = 1024  # 科教问答长度足够（不要太长省显存）
BATCH_SIZE = 4  # 根据显存调整（24G显存设4）
LEARNING_RATE = 2e-5  # SFT标准学习率
EPOCHS = 3  # 科教数据3轮足够，防止过拟合

# ====================== 2. LoRA 配置（高效微调核心）======================
lora_config = LoraConfig(
    r=8,  # LoRA秩（越小越省显存）
    lora_alpha=32,
    target_modules=["q_proj", "v_proj"],  # 只训注意力层
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM"
)


# ====================== 3. 数据加载与预处理 ======================
def load_sft_data(file_path):
    """加载JSONL数据，构造对话模板"""
    data = []
    with open(file_path, 'r', encoding='utf-8') as f:
        for line in f:
            item = json.loads(line.strip())
            instruction = item['instruction']
            response = item['response']

            # 标准指令模板（科教模型专用）
            prompt = f"### 问题：{instruction}\n### 回答：{response}"
            data.append({"text": prompt})
    return Dataset.from_list(data)


def tokenize_function(examples, tokenizer):
    """tokenize + 构建标签（只计算Response部分损失）"""
    inputs = tokenizer(
        examples["text"],
        truncation=True,
        max_length=MAX_SEQ_LEN,
        padding="max_length"
    )

    # 关键：SFT必须只算回答部分loss，问题部分不算loss
    labels = inputs["input_ids"].copy()
    for i, text in enumerate(examples["text"]):
        # 找到"### 回答："的位置
        sep_idx = text.find("### 回答：") + len("### 回答：")
        sep_token = tokenizer(text[:sep_idx], return_length=True)["length"][0]
        # 问题部分mask掉（设为-100，PyTorch忽略）
        labels[i][:sep_token] = [-100] * sep_token

    inputs["labels"] = labels
    return inputs


# ====================== 4. 加载模型与Tokenizer ======================
def main():
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
    tokenizer.pad_token = tokenizer.eos_token  # 设置pad_token

    # 加载4bit量化模型（省显存，单卡必开）
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_PATH,
        load_in_4bit=True,
        device_map="auto",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True
    )

    # 准备LoRA训练
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()  # 查看可训练参数（通常只有0.1%）

    # ====================== 5. 数据处理 ======================
    dataset = load_sft_data(TRAIN_FILE)
    dataset = dataset.map(
        lambda x: tokenize_function(x, tokenizer),
        batched=True,
        remove_columns=["text"]
    )

    # 切分训练集/验证集（95% / 5%）
    dataset = dataset.train_test_split(test_size=0.05, seed=42)
    train_dataset = dataset["train"]
    val_dataset = dataset["test"]

    # ====================== 6. 训练参数 ======================
    training_args = TrainingArguments(
        output_dir=OUTPUT_DIR,
        per_device_train_batch_size=BATCH_SIZE,
        per_device_eval_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=4,  # 模拟大batch
        learning_rate=LEARNING_RATE,
        num_train_epochs=EPOCHS,
        logging_steps=10,
        evaluation_strategy="epoch",  # 每轮验证
        save_strategy="epoch",  # 每轮保存
        fp16=True,  # 混合精度加速
        optim="paged_adamw_8bit",  # 8bit优化器省显存
        report_to="none"
    )

    # ====================== 7. 启动训练 ======================
    data_collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        data_collator=data_collator
    )

    trainer.train()
    model.save_pretrained(OUTPUT_DIR)  # 保存LoRA权重
    print(f"\n✅ SFT训练完成！LoRA权重保存在：{OUTPUT_DIR}")


if __name__ == "__main__":
    main()
