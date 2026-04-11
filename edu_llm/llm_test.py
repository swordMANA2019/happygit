import argparse
import json
import math
import os

import torch
from transformers import AutoTokenizer, Qwen2Config

from model import DecoderOnlyModel


@torch.no_grad()
def greedy_generate(model, tokenizer, prompt: str, max_new_tokens: int = 64):
    model.eval()
    device = next(model.parameters()).device
    input_ids = tokenizer.encode(prompt)
    if not input_ids:
        input_ids = [tokenizer.eos_token_id]
    input_ids = torch.tensor([input_ids], device=device)
    eos = tokenizer.eos_token_id

    for _ in range(max_new_tokens):
        logits = model(input_ids).logits
        next_id = logits[0, -1].argmax()
        input_ids = torch.cat([input_ids, next_id.view(1, 1)], dim=1)
        if eos is not None and next_id.item() == eos:
            break
    return tokenizer.decode(input_ids[0], skip_special_tokens=True)


def load_model_and_tokenizer(tokenizer_dir: str, model_weights_dir: str):
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_dir, local_files_only=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    config = Qwen2Config.from_pretrained(model_weights_dir)
    model = DecoderOnlyModel(config=config, dropout=0.1)

    weight_path = os.path.join(model_weights_dir, "pytorch_model.bin")
    state = torch.load(weight_path, map_location="cpu")
    model.load_state_dict(state)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    return model, tokenizer, device


def compute_perplexity(model, tokenizer, eval_json: str, max_samples: int, context_length: int):
    if not os.path.exists(eval_json):
        raise FileNotFoundError(f"eval file not found: {eval_json}")

    losses = []
    with open(eval_json, "r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= max_samples:
                break
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            text = item.get("text", "").strip()
            if not text:
                continue

            ids = tokenizer.encode(text, truncation=True, max_length=context_length)
            if len(ids) < 2:
                continue

            input_ids = torch.tensor([ids], device=next(model.parameters()).device)
            labels = input_ids.clone()
            out = model(input_ids=input_ids, labels=labels)
            losses.append(float(out.loss.item()))

    if not losses:
        return None, None
    mean_loss = sum(losses) / len(losses)
    ppl = math.exp(mean_loss)
    return mean_loss, ppl


def parse_args():
    parser = argparse.ArgumentParser(description="Test pretrained DecoderOnlyModel quality")
    parser.add_argument("--data_dir", type=str, required=True, help="数据目录（包含 tokenizer/ 和 model_weights/）")
    parser.add_argument("--max_new_tokens", type=int, default=64, help="生成最大token数")
    parser.add_argument("--eval_json", type=str, default="", help="可选：jsonl评估文件路径（每行至少包含 text 字段）")
    parser.add_argument("--max_eval_samples", type=int, default=200, help="评估样本上限")
    parser.add_argument("--context_length", type=int, default=512, help="评估时截断长度")
    return parser.parse_args()


def main():
    args = parse_args()
    tokenizer_dir = os.path.join(args.data_dir, "tokenizer")
    model_weights_dir = os.path.join(args.data_dir, "model_weights")

    model, tokenizer, device = load_model_and_tokenizer(tokenizer_dir, model_weights_dir)
    print(f"Loaded model on device: {device}")

    prompts = ["人工智能", "牛顿", "北京市", "亚洲历史"]
    print("\n=== Generation test ===")
    for p in prompts:
        out = greedy_generate(model, tokenizer, p, max_new_tokens=args.max_new_tokens)
        print(f"[{p}] {out}")

    if args.eval_json:
        print("\n=== Perplexity test ===")
        mean_loss, ppl = compute_perplexity(
            model=model,
            tokenizer=tokenizer,
            eval_json=args.eval_json,
            max_samples=args.max_eval_samples,
            context_length=args.context_length,
        )
        if mean_loss is None:
            print("No valid samples found in eval set.")
        else:
            print(f"eval_loss={mean_loss:.6f}, perplexity={ppl:.3f}, samples={args.max_eval_samples}")


if __name__ == "__main__":
    main()