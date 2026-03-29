import torch
from torch import nn

# hyper parameters
HIDDEN_SIZE = 192
N_HEAD = 6
N_LAYERS = 6

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
    def __init__(self, d_model, nhead, dropout=0.1):
        super().__init__()
        self.self_attn = nn.MultiheadAttention(d_model, nhead, batch_first=True, dropout=dropout)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        self.ffn = nn.Sequential(
            nn.Linear(d_model, d_model * 4),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(d_model * 4, d_model),
            nn.Dropout(dropout),
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
    def __init__(
        self,
        vocab_size,
        d_model=HIDDEN_SIZE,
        nhead=N_HEAD,
        num_layers=N_LAYERS,
        max_seq_len=2048,
        dropout=0.1,
    ):
        super().__init__()
        self.emb = nn.Embedding(vocab_size, d_model)
        self.pos = PositionalEncoding(d_model, max_len=max_seq_len)
        self.dropout = nn.Dropout(dropout)
        self.layers = nn.ModuleList([DecoderLayer(d_model, nhead, dropout=dropout) for _ in range(num_layers)])
        self.fc = nn.Linear(d_model, vocab_size)
        # Tie input/output embeddings to improve sample efficiency.
        self.fc.weight = self.emb.weight
        self.register_buffer(
            "causal_mask",
            torch.triu(torch.ones(max_seq_len, max_seq_len, dtype=torch.bool), diagonal=1),
            persistent=False,
        )

    def forward(self, x):
        _, L = x.shape
        if L > self.causal_mask.size(0):
            raise ValueError(f"sequence length {L} exceeds max_seq_len {self.causal_mask.size(0)}")
        x = self.emb(x)
        x = self.pos(x)
        x = self.dropout(x)

        # 因果掩码：只能看左边
        mask = self.causal_mask[:L, :L].to(x.device)
        for layer in self.layers:
            x = layer(x, mask)

        logits = self.fc(x)
        return logits
