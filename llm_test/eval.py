import argparse
import os

import torch
from transformers import BertTokenizer

from model import DecoderOnlyModel


MAX_SEQ_LEN = 128
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def resolve_model_dir():
    env_path = os.environ.get("SCIENCE_MODEL_DIR")
    candidates = []
    if env_path:
        candidates.append(env_path)
    candidates.extend(
        [
            os.path.join(os.getcwd(), "llm_test", "edu_science_small"),
            os.path.join(os.getcwd(), "edu_science_small"),
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "edu_science_small"),
        ]
    )
    for path in candidates:
        if os.path.isfile(os.path.join(path, "model.pt")):
            return path
    raise FileNotFoundError(
        "Model directory not found. Expected model.pt under one of: "
        + ", ".join(candidates)
        + ". You can set SCIENCE_MODEL_DIR=/full/path/to/edu_science_small"
    )


def load_infer_components(model_dir):
    tokenizer = BertTokenizer.from_pretrained(model_dir)
    model = DecoderOnlyModel(tokenizer.vocab_size, max_seq_len=MAX_SEQ_LEN, dropout=0.0).to(device)
    model_path = os.path.join(model_dir, "model.pt")
    state = torch.load(model_path, map_location=device)
    model.load_state_dict(state, strict=True)
    model.eval()
    return tokenizer, model


@torch.no_grad()
def generate_text(
    model,
    tokenizer,
    prompt,
    max_new_tokens=64,
    temperature=0.8,
    top_k=20,
    do_sample=True,
):
    input_ids = tokenizer.encode(prompt, add_special_tokens=False)
    if not input_ids:
        raise ValueError("Prompt is empty after tokenization.")

    eos_id = tokenizer.sep_token_id
    generated = list(input_ids)

    for _ in range(max_new_tokens):
        # Keep context window within training length.
        ctx = generated[-MAX_SEQ_LEN:]
        x = torch.tensor([ctx], dtype=torch.long, device=device)
        logits = model(x)
        next_logits = logits[0, -1, :]

        if do_sample:
            temp = max(1e-4, float(temperature))
            next_logits = next_logits / temp
            if top_k > 0:
                k = min(int(top_k), next_logits.size(-1))
                values, _ = torch.topk(next_logits, k)
                threshold = values[-1]
                next_logits = torch.where(
                    next_logits < threshold,
                    torch.full_like(next_logits, float("-inf")),
                    next_logits,
                )
            probs = torch.softmax(next_logits, dim=-1)
            next_id = int(torch.multinomial(probs, num_samples=1).item())
        else:
            next_id = int(torch.argmax(next_logits).item())

        generated.append(next_id)
        if eos_id is not None and next_id == eos_id:
            break

    out_ids = generated[len(input_ids) :]
    return tokenizer.decode(out_ids, skip_special_tokens=True)


def main():
    parser = argparse.ArgumentParser(description="Inference for edu_science_small model.")
    parser.add_argument(
        "--prompt",
        type=str,
        default="",
        help="Single prompt to run once. If empty, start interactive mode.",
    )
    parser.add_argument("--max-new-tokens", type=int, default=80)
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--greedy", action="store_true", help="Use greedy decoding instead of sampling.")
    args = parser.parse_args()

    model_dir = resolve_model_dir()
    print(f"Using model dir: {model_dir}")
    print(f"Using device: {device}")
    tokenizer, model = load_infer_components(model_dir)

    if args.prompt:
        answer = generate_text(
            model,
            tokenizer,
            args.prompt,
            max_new_tokens=args.max_new_tokens,
            temperature=args.temperature,
            top_k=args.top_k,
            do_sample=not args.greedy,
        )
        print("Q:", args.prompt)
        print("A:", answer)
        return

    print("Interactive mode. Type 'exit' to quit.")
    while True:
        prompt = input("\nQ> ").strip()
        if not prompt:
            continue
        if prompt.lower() in {"exit", "quit"}:
            break
        answer = generate_text(
            model,
            tokenizer,
            prompt,
            max_new_tokens=args.max_new_tokens,
            temperature=args.temperature,
            top_k=args.top_k,
            do_sample=not args.greedy,
        )
        print("A>", answer)


if __name__ == "__main__":
    main()
