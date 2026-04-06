from transformers import AutoTokenizer, AutoModelForCausalLM
import torch

# ====================== 配置 =======================
MODEL_PATH = "./edu_chat_model"  # 上面合并好的完整模型路径

# 加载模型
tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
model = AutoModelForCausalLM.from_pretrained(
    MODEL_PATH,
    torch_dtype=torch.bfloat16,
    device_map="auto",
    trust_remote_code=True
)


# 科教问答Prompt模板（和SFT保持一致）
def build_prompt(instruction):
    return f"### 问题：{instruction}\n### 回答："


# 生成回答
def ask_edu_model(question):
    prompt = build_prompt(question)
    inputs = tokenizer(prompt, return_tensors="pt").to("cuda")

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=800,  # 科教回答长度
            temperature=0.3,  # 越低越严谨（科教必须低）
            top_p=0.9,
            repetition_penalty=1.05,
            do_sample=True,
            eos_token_id=tokenizer.eos_token_id
        )

    response = tokenizer.decode(outputs[0][len(inputs["input_ids"][0]):], skip_special_tokens=True)
    return response


# ====================== 测试 =======================
if __name__ == "__main__":
    print("✅ 科教大模型已加载，输入问题开始测试（输入q退出）")
    while True:
        question = input("\n请输入问题：")
        if question.lower() == "q":
            break
        answer = ask_edu_model(question)
        print("\n### 模型回答：\n", answer)
