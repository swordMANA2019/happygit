from pycparser.ply.yacc import token
from transformers import Qwen2Config
import argparse
import torch
from common import get_data_paths,load_tokenizer
from model import DecoderOnlyModel


# ===================== 命令行参数 =====================
def parse_args():
    parser = argparse.ArgumentParser(description="Decoder-Only LLM Eval Script")
    parser.add_argument("--data_dir", type=str, required=True, help="数据根目录")
    return parser.parse_args()

'''
model = Qwen2ForCausalLM.from_pretrained(
    paths["model_weights"],
    torch_dtype=torch.bfloat16,
    device_map="auto",
    trust_remote_code=True
)
'''
def load_model(path, tokenizer):
    # Ensure <|pad|> token exists in the tokenizer before building the config.
    # Without this the pad_token_id is None and the model generates pad tokens
    # as content (shows up as empty brackets in output).
    if tokenizer.pad_token_id is None:
        tokenizer.add_special_tokens({"pad_token": "<|pad|>"})

    state_dict = torch.load(
        path["model_weights"] + "/pytorch_model.bin",
        map_location="cpu",
        weights_only=False,
    )
    config = Qwen2Config(
        vocab_size=len(tokenizer),          # must reflect any newly added tokens
        hidden_size=512,
        intermediate_size=2048,
        num_attention_heads=8,
        num_hidden_layers=12,
        max_position_embeddings=1024,
        bos_token_id=tokenizer.bos_token_id,
        eos_token_id=tokenizer.eos_token_id,
        pad_token_id=tokenizer.pad_token_id,
    )
    model = DecoderOnlyModel(config=config, dropout=0.1)
    model.load_state_dict(state_dict)
    return model

# 科教问答Prompt模板（和SFT保持一致）
def build_prompt(instruction):
    return f"### 问题：{instruction}\n### 回答："


# 生成回答
def ask_edu_model(model:DecoderOnlyModel, question:str, tokenizer):
    # prompt = build_prompt(question)
    prompt = question
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    input_ids = torch.tensor([tokenizer.encode(prompt) or [tokenizer.eos_token_id]], device=device)
    with torch.no_grad():
        outputs = model.generate(
            input_ids,
            max_new_tokens=300,
            temperature=0.8,          # was 0.3; higher temperature reduces degenerate loops
            top_p=0.9,
            repetition_penalty=1.3,   # was 1.05; stronger penalty suppresses () repetition
            do_sample=True,
            eos_token_id=tokenizer.eos_token_id,
            pad_token_id=tokenizer.pad_token_id,  # prevents pad tokens appearing as content
        )

    response = tokenizer.decode(outputs[0][len(input_ids[0]):], skip_special_tokens=True)
    return response


# ====================== 测试 =======================
if __name__ == "__main__":
    print("✅ 科教大模型已加载，输入问题开始测试（输入q退出）")
    # answer = ask_edu_model("2019冠状病毒")
    # print("\n### 模型回答：\n", answer)
    args = parse_args()
    path = get_data_paths(args.data_dir)
    tokenizer = load_tokenizer(path["tokenizer_dir"])
    model = load_model(path, tokenizer)
    while True:
        question = input("\n请输入问题：")
        if question.lower() == "q":
            break
        answer = ask_edu_model(model, question, tokenizer)
        print("\n### 模型回答：\n", answer)
