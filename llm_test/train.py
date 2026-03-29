import os
import random
import math

import torch
import torch.optim as optim
from torch import nn
from torch.utils.data import Dataset, DataLoader
from transformers import BertTokenizer

from model import DecoderOnlyModel


lr = 3e-4
batch_size = 2
grad_accum_steps = 16
epochs = 12
MAX_SEQ_LEN = 128
weight_decay = 0.01
warmup_ratio = 0.06
seed = 42

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def set_seed(s):
    random.seed(s)
    torch.manual_seed(s)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(s)


def resolve_data_file():
    # Priority: explicit env var -> current working dir -> script dir.
    env_path = os.environ.get("SCIENCE_PRETRAIN_FILE")
    candidates = []
    if env_path:
        candidates.append(env_path)
    candidates.extend(
        [
            os.path.join(os.getcwd(), "data", "science_pretrain.txt"),
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "science_pretrain.txt"),
        ]
    )
    for path in candidates:
        if os.path.isfile(path):
            return path
    raise FileNotFoundError(
        "science_pretrain.txt not found. "
        "Expected one of: "
        + ", ".join(candidates)
        + ". You can also set SCIENCE_PRETRAIN_FILE=/full/path/to/science_pretrain.txt"
    )


class TextDataset(Dataset):
    def __init__(self, file_path, tokenizer, max_len):
        self.max_len = max_len
        with open(file_path, "r", encoding="utf-8") as f:
            corpus = "\n".join(line.strip() for line in f if line.strip())
        ids = tokenizer.encode(corpus, add_special_tokens=False)
        if len(ids) <= max_len:
            raise RuntimeError(
                f"Tokenized corpus too small ({len(ids)} tokens). "
                f"Need > {max_len} tokens to build training blocks."
            )
        # Make contiguous fixed blocks for stable memory and better token utilization.
        n_blocks = (len(ids) - 1) // max_len
        self.blocks = []
        for i in range(n_blocks):
            start = i * max_len
            block = ids[start : start + max_len + 1]
            if len(block) == max_len + 1:
                self.blocks.append(torch.tensor(block, dtype=torch.long))

    def __len__(self):
        return len(self.blocks)

    def __getitem__(self, idx):
        block = self.blocks[idx]
        return {"input_ids": block[:-1], "labels": block[1:]}


def main():
    set_seed(seed)
    tokenizer = BertTokenizer.from_pretrained("bert-base-chinese")
    vocab_size = tokenizer.vocab_size

    model = DecoderOnlyModel(vocab_size, max_seq_len=MAX_SEQ_LEN, dropout=0.1).to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay, betas=(0.9, 0.95))

    data_file = resolve_data_file()
    print(f"Using data file: {data_file}")
    dataset = TextDataset(data_file, tokenizer, MAX_SEQ_LEN)
    if len(dataset) == 0:
        raise RuntimeError(f"Dataset is empty: {data_file}")
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True, drop_last=True)
    use_amp = torch.cuda.is_available()
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    total_update_steps = max(1, (len(loader) * epochs) // grad_accum_steps)
    warmup_steps = int(total_update_steps * warmup_ratio)
    update_count = 0

    model.train()
    for epoch in range(epochs):
        total_loss = 0.0
        optimizer.zero_grad(set_to_none=True)
        for i, batch in enumerate(loader, start=1):
            input_ids = batch["input_ids"].to(device)
            labels = batch["labels"].to(device)
            with torch.amp.autocast("cuda", enabled=use_amp):
                logits = model(input_ids)
                loss = criterion(logits.view(-1, vocab_size), labels.view(-1))
                loss = loss / grad_accum_steps

            scaler.scale(loss).backward()
            total_loss += loss.item() * grad_accum_steps

            if i % grad_accum_steps == 0:
                scaler.unscale_(optimizer)
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
                update_count += 1

                # Linear warmup + cosine decay.
                if update_count <= warmup_steps and warmup_steps > 0:
                    cur_lr = lr * (update_count / warmup_steps)
                else:
                    progress = (update_count - warmup_steps) / max(1, total_update_steps - warmup_steps)
                    progress = min(1.0, max(0.0, progress))
                    cur_lr = lr * 0.5 * (1.0 + math.cos(progress * math.pi))
                for pg in optimizer.param_groups:
                    pg["lr"] = max(1e-5, cur_lr)

        avg_loss = total_loss / max(1, len(loader))
        ppl = torch.exp(torch.tensor(avg_loss)).item()
        print(f"Epoch {epoch+1}, avg loss: {avg_loss:.4f}, ppl: {ppl:.2f}, updates: {update_count}")

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "edu_science_small")
    os.makedirs(out_dir, exist_ok=True)
    torch.save(model.state_dict(), os.path.join(out_dir, "model.pt"))
    tokenizer.save_pretrained(out_dir)


if __name__ == "__main__":
    main()
