# DecoderOnlyModel Structure and GPU Memory Cost

## 1) DecoderOnlyModel graph (with tensor sizes)

Below is the structure implemented in `edu_llm/model.py`:

```text
input_ids [B, T]
   |
   v
Embedding(vocab_size -> d_model)
   output: [B, T, d_model]
   |
   v
PositionalEncoding + Dropout
   output: [B, T, d_model]
   |
   v
N x DecoderLayer
   each layer:
     x [B, T, d_model]
      -> MultiHead Self-Attention (causal mask [T, T])
      -> Residual + LayerNorm
      -> FFN: Linear(d_model->intermediate_size)->GELU->Linear(intermediate_size->d_model)
      -> Residual + LayerNorm
   output: [B, T, d_model]
   |
   v
LM Head Linear(d_model -> vocab_size)  (weight tied with embedding)
   logits: [B, T, vocab_size]
   |
   v
Shifted CrossEntropy Loss
```

### Current training sizes used in this repo

- Default profile (larger): `d_model=512`, `layers=12`, `heads=8`, `intermediate=2048`, `T=512`
- Low VRAM profile (2GB mode): `d_model=256`, `layers=6`, `heads=4`, `intermediate=1024`, `T<=128`

Example shape (2GB mode, batch=1, T=128):

- Embedding output: `[1, 128, 256]`
- Per-head attention matrix in each layer: `[1, 4, 128, 128]`
- Final logits: `[1, 128, vocab_size]`

---

## 2) What consumes GPU memory during training

Total GPU memory is approximately:

```text
M_total ~= M_params + M_grads + M_optim + M_acts + M_attn + M_inputs + M_runtime_overhead
```

### A) Parameters (`M_params`)

Model weights on GPU.

Formula:

```text
M_params = P * bytes(dtype)
```

- `P`: number of parameters
- fp32: 4 bytes, fp16/bf16: 2 bytes

### B) Gradients (`M_grads`)

Allocated after `loss.backward()`, same shape as parameters.

Formula:

```text
M_grads ~= P * bytes(grad_dtype)
```

### C) Optimizer states (`M_optim`)

For AdamW, each parameter typically has:

- `exp_avg` (m)
- `exp_avg_sq` (v)

Usually both fp32.

Formula:

```text
M_optim ~= 2 * P * 4 bytes
```

### D) Activations (`M_acts`)

Intermediate tensors saved from forward for backward.

Rule of thumb:

```text
M_acts ∝ L * B * T * H * bytes * k
```

- `L`: layers
- `B`: batch size
- `T`: context length
- `H`: hidden size
- `k`: framework/kernel dependent factor (multiple saved tensors)

Why big: backward needs forward intermediates.

### E) Attention score/probability tensors (`M_attn`)

Self-attention builds token-to-token matrices (`T x T`) per head.

Rule of thumb:

```text
M_attn ∝ L * B * A * T^2 * bytes
```

- `A`: attention heads
- This is why `context_length` is the most sensitive knob.

### F) Inputs and labels (`M_inputs`)

- `input_ids`, `labels`, masks, small compared to activations/attention in most cases.

### G) Runtime overhead (`M_runtime_overhead`)

- CUDA context
- PyTorch caching allocator reserved memory
- temporary kernel workspaces
- fragmentation

This part explains why `reserved` may be much larger than `allocated`.

---

## 3) Mapping to PyTorch training flow

### Forward (creates activations)

From `model.py`:

```python
h = self.emb(input_ids)
h = self.pos(h)
for layer in self.layers:
    h = layer(h, mask)
logits = self.fc(h)
loss = F.cross_entropy(...)
```

These forward intermediates are saved for backward unless disabled/recomputed.

### Backward (creates/uses gradients)

Typical trainer step (conceptual):

```python
loss.backward()
```

Autograd traverses graph backward and fills `p.grad` for parameters.

### Optimizer step (creates/uses optimizer state)

AdamW keeps state per parameter:

```python
optimizer.step()
# state[p]["exp_avg"], state[p]["exp_avg_sq"] are maintained
```

So optimizer memory is persistent and large for big `P`.

---

## 4) Why 2GB GPU OOM happens quickly

Main reasons:

- `T` too long -> attention `T^2` blows up
- model too deep/wide -> `P` and activations increase
- batch too large -> all activation tensors scale with `B`

In this repo, low VRAM mode fixes this by:

- reducing `T` to `<=128`
- using smaller model config
- enabling gradient checkpointing
- using tiny micro-batch and higher grad accumulation
- disabling in-training eval spikes

---

## 5) Quick calculation cheatsheet

Let `bytes=2` for fp16/bf16 and `bytes=4` for fp32.

1. Static model state (rough estimate for AdamW mixed precision):

```text
M_static ~= P * (params + grads + optimizer)
        ~= P * (2~4 + 2~4 + 8) bytes
        ~= P * (12~16) bytes
```

2. Attention growth check:

```text
T: 128 -> 256  => attention memory ~4x
T: 128 -> 512  => attention memory ~16x
```

So on 2GB GPUs, reduce `T` first, then tune batch/grad_accum.
