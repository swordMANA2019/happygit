from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

# ====================== 配置（改这里）======================
BASE_MODEL_PATH = "./base_model"  # 你的原始基座（Wikipedia预训练模型）
LORA_MODEL_PATH = "./sft_lora_model"  # SFT训练出的LoRA权重路径
MERGED_OUTPUT_PATH = "./edu_chat_model"  # 合并后完整科教模型保存路径


def merge_lora_to_base():
    print("加载基座模型...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_PATH)
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL_PATH,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        trust_remote_code=True
    )

    print("加载LoRA权重...")
    model = PeftModel.from_pretrained(model, LORA_MODEL_PATH)

    print("开始合并...")
    model = model.merge_and_unload()  # 核心：合并LoRA

    print("保存合并后模型...")
    model.save_pretrained(MERGED_OUTPUT_PATH, safe_serialization=True)
    tokenizer.save_pretrained(MERGED_OUTPUT_PATH)

    print(f"✅ 合并完成！完整科教模型保存在：{MERGED_OUTPUT_PATH}")


if __name__ == "__main__":
    merge_lora_to_base()
