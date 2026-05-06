import torch
import torch.nn.functional as F
from torch import nn
from transformers.modeling_outputs import CausalLMOutputWithPast

# hyper parameters
HIDDEN_SIZE = 512
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
    def __init__(self, d_model, nhead, intermediate_size=None, dropout=0.1):
        super().__init__()
        if intermediate_size is None:
            intermediate_size = d_model * 4
        self.self_attn = nn.MultiheadAttention(d_model, nhead, batch_first=True, dropout=dropout)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)

        # intermediate_size is the FFN/MLP expansion width
        # (hidden_size -> intermediate_size -> hidden_size).
        # Defaulting to 4x d_model is a common Transformer choice.
        self.ffn = nn.Sequential(
            nn.Linear(d_model, intermediate_size),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(intermediate_size, d_model),
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
        vocab_size:int = None,
        d_model = HIDDEN_SIZE,
        nhead = N_HEAD,
        num_layers = N_LAYERS,
        intermediate_size = None,
        max_seq_len = 1024,
        dropout = 0.1,
        config = None,
    ):
        super().__init__()
        _vocab_size = vocab_size
        _d_model = d_model
        _nhead = nhead
        _nlayers = num_layers
        _intermediate_size = intermediate_size
        _max_seq_len = max_seq_len
        _dropout = dropout
        if config is not None:
            _vocab_size = config.vocab_size
            _d_model = config.hidden_size
            _nhead = config.num_attention_heads
            _nlayers = config.num_hidden_layers
            _ntermediate_size = getattr(config, "intermediate_size", None)
            _max_seq_len = config.max_position_embeddings
            # Align decoder dropout with HF config when provided.
            _dropout = getattr(config, "attention_dropout", dropout)
            self.bos_token_id = getattr(config, "bos_token_id", None)
            self.eos_token_id = getattr(config, "eos_token_id", None)
        else:
            self.bos_token_id = None
            self.eos_token_id = None
        if _vocab_size is None:
            raise ValueError("vocab_size must be provided when config is None")
        if intermediate_size is None:
            _intermediate_size = d_model * 4
        self.vocab_size = _vocab_size
        self.config = config if config is not None else None
        self.emb = nn.Embedding(_vocab_size, _d_model)
        self.pos = PositionalEncoding(_d_model, max_len=_max_seq_len)
        self.dropout = nn.Dropout(_dropout)
        self.layers = nn.ModuleList(
            [
                DecoderLayer(_d_model, _nhead, intermediate_size=_intermediate_size, dropout=dropout)
                for _ in range(num_layers)
            ]
        )
        self.fc = nn.Linear(_d_model, _vocab_size)
        # Tie input/output embeddings to improve sample efficiency.
        self.fc.weight = self.emb.weight
        self.register_buffer(
            "causal_mask",
            torch.triu(torch.ones(_max_seq_len, _max_seq_len, dtype=torch.bool), diagonal=1),
            persistent=False,
        )

    def forward(self, input_ids=None, labels=None, attention_mask=None, x=None, **kwargs):
        # Trainer passes input_ids/labels; legacy callers may pass x=...
        if input_ids is None:
            input_ids = x
        if input_ids is None:
            raise ValueError("forward requires input_ids or x")

        _, L = input_ids.shape
        if L > self.causal_mask.size(0):
            raise ValueError(f"sequence length {L} exceeds max_seq_len {self.causal_mask.size(0)}")
        h = self.emb(input_ids)
        h = self.pos(h)
        h = self.dropout(h)

        mask = self.causal_mask[:L, :L].to(h.device)
        for layer in self.layers:
            h = layer(h, mask)

        logits = self.fc(h)

        loss = None
        if labels is not None:
            shift_logits = logits[..., :-1, :].contiguous()
            shift_labels = labels[..., 1:].contiguous()
            loss = F.cross_entropy(
                shift_logits.view(-1, self.vocab_size),
                shift_labels.view(-1),
                ignore_index=-100,
            )

        return CausalLMOutputWithPast(loss=loss, logits=logits, past_key_values=None)
