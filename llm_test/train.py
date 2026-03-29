
import os

import torch
import torch.optim as optim
from torch import nn
from torch.utils.data import Dataset, DataLoader
from transformers import BertTokenizer

from model import DecoderOnlyModel


lr = 1e-3
batch_size = 16
epochs = 8
MAX_SEQ_LEN = 1000

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


class TextDataset(Dataset):
    def __init__(self, file_path, tokenizer, max_len):
        self.tokenizer = tokenizer
        self.max_len = max_len
        with open(file_path, "r", encoding="utf-8") as f:
            self.lines = [line.strip() for line in f if line.strip()]

    def __len__(self):
        return len(self.lines)

    def __getitem__(self, idx):
        text = self.lines[idx]
        enc = self.tokenizer(
            text,
            truncation=True,
            max_length=self.max_len,
            padding="max_length",
            return_tensors="pt",
        )
        input_ids = enc["input_ids"].squeeze(0)
        return {"input_ids": input_ids}


def main():
    tokenizer = BertTokenizer.from_pretrained("bert-base-chinese")
    vocab_size = tokenizer.vocab_size
    pad_id = tokenizer.pad_token_id

    model = DecoderOnlyModel(vocab_size, max_seq_len=MAX_SEQ_LEN).to(device)
    criterion = nn.CrossEntropyLoss(ignore_index=-100)
    optimizer = optim.Adam(model.parameters(), lr)

    data_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "science_pretrain.txt")
    dataset = TextDataset(data_file, tokenizer, MAX_SEQ_LEN)
    loader = DataLoader(dataset, batch_size, shuffle=True)

    model.train()
    for epoch in range(epochs):
        total_loss = 0.0
        for batch in loader:
            input_ids = batch["input_ids"].to(device)
            logits = model(input_ids)
            # Causal LM: position t predicts token t+1
            shift_logits = logits[:, :-1, :].contiguous()
            shift_labels = input_ids[:, 1:].contiguous()
            shift_labels = shift_labels.masked_fill(shift_labels == pad_id, -100)
            loss = criterion(
                shift_logits.view(-1, vocab_size),
                shift_labels.view(-1),
            )
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            total_loss += loss.item()

        print(f"Epoch {epoch+1}, avg loss: {total_loss / len(loader):.4f}")

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "edu_science_small")
    os.makedirs(out_dir, exist_ok=True)
    torch.save(model.state_dict(), os.path.join(out_dir, "model.pt"))
    tokenizer.save_pretrained(out_dir)


if __name__ == "__main__":
    main()
