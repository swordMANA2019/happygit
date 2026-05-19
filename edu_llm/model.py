import torch
import torch.nn.functional as F
from torch import nn
from transformers.modeling_outputs import CausalLMOutputWithPast
from transformers import AutoModelForCausalLM,PreTrainedModel

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
            _intermediate_size = getattr(config, "intermediate_size", None)
            _max_seq_len = config.max_position_embeddings
            # Keep the caller-supplied dropout; only fall back to config's
            # attention_dropout when the caller left dropout at its default (0.1).
            # Qwen2Config.attention_dropout defaults to 0.0, so blindly using it
            # would silently zero out all regularisation.
            config_attn_dropout = getattr(config, "attention_dropout", None)
            if config_attn_dropout is not None and config_attn_dropout > 0.0:
                _dropout = config_attn_dropout
            self.bos_token_id = getattr(config, "bos_token_id", None)
            self.eos_token_id = getattr(config, "eos_token_id", None)
        else:
            self.bos_token_id = None
            self.eos_token_id = None
        if _vocab_size is None:
            raise ValueError("vocab_size must be provided when config is None")
        if _intermediate_size is None:
            _intermediate_size = _d_model * 4
        self.vocab_size = _vocab_size
        self.config = config if config is not None else None
        self.emb = nn.Embedding(_vocab_size, _d_model)
        self.pos = PositionalEncoding(_d_model, max_len=_max_seq_len)
        self.dropout = nn.Dropout(_dropout)
        self.layers = nn.ModuleList(
            [
                DecoderLayer(_d_model, _nhead, intermediate_size=_intermediate_size, dropout=dropout)
                for _ in range(_nlayers)
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

    def generate(
            self,
            input_ids,
            max_new_tokens=800,
            temperature=0.3,
            top_p=0.9,
            repetition_penalty=1.05,
            do_sample=True,
            eos_token_id=None,
            pad_token_id=None
    ):
        # ========== 动态控制回答长度 ==========
        seq_len = input_ids.shape[1]
        if seq_len <= 15:
            max_new_tokens = 100
        elif seq_len <= 30:
            max_new_tokens = 300
        self.eval()
        generated = input_ids.clone()
        for _ in range(max_new_tokens):
            with torch.no_grad():
                outputs = self(generated)

            logits = outputs.logits[:, -1, :]  # 取最后一个token

            # --------------------------
            # 1. 重复惩罚（关键！）
            # --------------------------
            if repetition_penalty != 1.0:
                for i in range(generated.shape[1]):
                    tok = generated[:, i].unsqueeze(-1)
                    logits.scatter_(dim=-1,
                                    index=tok,
                                    src=logits.gather(-1, tok) / repetition_penalty)
            # --------------------------
            # 2. 温度采样
            # --------------------------
            logits = logits / temperature
            # --------------------------
            # 3. Top-p 核采样
            # --------------------------
            if do_sample and top_p > 0:
                sorted_logits, sorted_indices = torch.sort(logits, descending=True)
                cumulative_probs = torch.cumsum(torch.softmax(sorted_logits, dim=-1), dim=-1)
                sorted_indices_to_remove = cumulative_probs > top_p
                sorted_indices_to_remove[..., 1:] = sorted_indices_to_remove[..., :-1].clone()
                sorted_indices_to_remove[..., 0] = 0
                for i in range(sorted_indices.shape[0]):
                    idx = sorted_indices[i][sorted_indices_to_remove[i]]
                    logits[i, idx] = -float("inf")

            # --------------------------
            # 采样 / 贪心
            # --------------------------
            if do_sample:
                probs = torch.softmax(logits, dim=-1)
                next_token = torch.multinomial(probs, num_samples=1)
            else:
                next_token = torch.argmax(logits, dim=-1, keepdim=True)

            # 追加 token
            generated = torch.cat([generated, next_token], dim=-1)

            # 遇到结束符停止
            if next_token.item() == eos_token_id:
                break

        return generated