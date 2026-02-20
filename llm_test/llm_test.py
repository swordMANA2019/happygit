import os
import random
# 避免在 fork 环境中 CUDA 初始化失败（如 IDE 子进程）
os.environ.setdefault("PYTORCH_NVML_BASED_CUDA_CHECK", "1")

import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.optim as optim

# 设备：有 CUDA 用 GPU，否则用 CPU
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Using device: {device}")

# --------------------------
# 1. 位置编码
# --------------------------
class PositionalEncoding(nn.Module):
    def __init__(self, d_model, max_len=200):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, d_model, 2).float() * (-torch.log(torch.tensor(10000.0)) / d_model))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        pe = pe.unsqueeze(0)
        self.register_buffer('pe', pe)

    def forward(self, x):
        return x + self.pe[:, :x.size(1)]

# --------------------------
# 2. 单个 Decoder 层（ causal mask）
# --------------------------
class DecoderLayer(nn.Module):
    def __init__(self, d_model, nhead):
        super().__init__()
        self.self_attn = nn.MultiheadAttention(d_model, nhead, batch_first=True)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        self.ffn = nn.Sequential(
            nn.Linear(d_model, d_model * 2),
            nn.ReLU(),
            nn.Linear(d_model * 2, d_model)
        )

    def forward(self, x, attn_mask):
        attn_out, _ = self.self_attn(x, x, x, attn_mask=attn_mask)
        x = self.norm1(x + attn_out)
        x = self.norm2(x + self.ffn(x))
        return x

# --------------------------
# 3. Decoder-Only 模型（GPT 结构）
# --------------------------
class DecoderOnlyModel(nn.Module):
    def __init__(self, vocab_size, d_model=64, nhead=2, num_layers=2):
        super().__init__()
        self.emb = nn.Embedding(vocab_size, d_model)
        self.pos = PositionalEncoding(d_model)
        self.layers = nn.ModuleList([DecoderLayer(d_model, nhead) for _ in range(num_layers)])
        self.fc = nn.Linear(d_model, vocab_size)

    def forward(self, x):
        B, L = x.shape
        x = self.emb(x)
        x = self.pos(x)

        # 因果掩码：只能看左边
        mask = nn.Transformer.generate_square_subsequent_mask(L).to(x.device)
        for layer in self.layers:
            x = layer(x, mask)

        logits = self.fc(x)
        return logits

# --------------------------
# 4. 词典 & SFT 数据
# --------------------------
# SFT 数据：直接添加 (问题, 答案) 对即可。答案建议以 。 结尾，便于推理时停止
sft_data = [
    ("猫看到老鼠，它飞快地跑起来了。它指的是什么", "猫。"),
    ("猫喜欢吃什么？", "鱼。"),
    ("老鼠怕什么？", "猫。"),
]

# 测试问题（需在 build_sft_batch 之前定义，用于构建词典）
test_questions = [
    "猫看到老鼠，它飞快地跑起来了。它指的是什么",
    "猫喜欢吃什么？",
    "老鼠怕什么？",
]

# 从 SFT 数据 + 测试问题构建词典，避免推理时 OOV
_SEP = "。"
all_chars = sorted(set("".join(q + a for q, a in sft_data) + "".join(test_questions) + _SEP))
vocab = ["[PAD]"] + all_chars
w2i = {w: i for i, w in enumerate(vocab)}
i2w = {i: w for i, w in enumerate(vocab)}
vocab_size = len(vocab)


def build_sft_pair(q, a):
    """单个 (question, answer) 转为 inputs, targets, loss_mask。"""
    seq = list(q + a)
    indices = [w2i[c] for c in seq]
    inputs = indices[:-1]
    targets = indices[1:]
    mask = [0] * (len(q) - 1) + [1] * len(a)
    return (
        torch.tensor([inputs], device=device),
        torch.tensor([targets], device=device),
        torch.tensor([mask], dtype=torch.float, device=device),
    )

# --------------------------
# 5. 训练
# --------------------------
model = DecoderOnlyModel(vocab_size).to(device)
criterion = nn.CrossEntropyLoss()
optimizer = optim.Adam(model.parameters(), lr=1e-3)

model.train()
step = 0
for epoch in range(400):
    total_loss = 0.0
    pairs = sft_data.copy()
    random.shuffle(pairs)
    for q, a in pairs:
        inp, tgt, mask = build_sft_pair(q, a)
        optimizer.zero_grad()
        logits = model(inp)
        per_token_loss = F.cross_entropy(
            logits.reshape(-1, vocab_size), tgt.reshape(-1), reduction="none"
        )
        masked_loss = (per_token_loss * mask.reshape(-1)).sum() / mask.sum().clamp(min=1)
        masked_loss.backward()
        optimizer.step()
        total_loss += masked_loss.item()
        step += 1
    if epoch % 20 == 0:
        print(f"epoch {epoch} loss={total_loss / len(sft_data):.4f}")

# --------------------------
# 6. 推理：测试问题列表
# --------------------------
def str_to_indices(s):
    """字符串转 token 索引，未知字符用 [PAD]"""
    return [w2i.get(c, 0) for c in s]


def generate(prefix_str, max_new_tokens=10, stop_at=None):
    """给定问题，自回归生成答案。stop_at: 遇到这些字符时停止。"""
    if stop_at is None:
        stop_at = {"。", "？", "！"}
    gen = str_to_indices(prefix_str)
    with torch.no_grad():
        for _ in range(max_new_tokens):
            inp = torch.tensor([gen], device=device)
            logits = model(inp)
            next_token = logits.argmax(-1)[:, -1].item()
            gen.append(next_token)
            if i2w[next_token] in stop_at:
                break
    return "".join([i2w[i] for i in gen])


model.eval()
print("\n" + "=" * 50)
print("推理测试")
print("=" * 50)
for q in test_questions:
    out = generate(q)
    print(f"Q: {q}")
    print(f"A: {out[len(q):]}")  # 只打印续写部分
    print()
