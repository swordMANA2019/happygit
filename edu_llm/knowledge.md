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

---

## Appendix: BOS / EOS in Chinese Pretraining

### What BOS and EOS Mean

- `bos_token_id`: beginning-of-sequence token ID, marks sequence start.
- `eos_token_id`: end-of-sequence token ID, marks sequence end.

In decoder-only models, these tokens are usually applied in the data and generation pipeline, not via special logic in `model.forward()`.

### Why `model.forward()` Does Not Special-Handle BOS/EOS

`DecoderOnlyModel` takes token IDs and computes logits. It does not branch on token type like:

- `if token == bos_token_id: ...`
- `if token == eos_token_id: ...`

So BOS/EOS are used by sequence construction and stopping rules, then consumed as normal tokens by the model.

### Chinese Pretraining Scenarios

#### 1) Multi-document pretraining (most common)

You have two corpus samples:

- Doc A: `牛顿提出了万有引力定律。`
- Doc B: `细胞由细胞膜和细胞核组成。`

If concatenated directly (no boundary):

`...万有引力定律。细胞由...`

The model may learn false cross-document continuity.

With `EOS`:

`牛顿提出了万有引力定律。<eos>细胞由细胞膜和细胞核组成。<eos>`

Now the model learns clear sample boundaries.

`BOS` is optional:

- `<bos>牛顿提出了万有引力定律。<eos>`
- `<bos>细胞由细胞膜和细胞核组成。<eos>`

#### 2) Instruction/chat fine-tuning

Chinese sample:

- User: `请解释光合作用。`
- Assistant: `光合作用是绿色植物利用光能合成有机物的过程。`

Formatted:

`<bos><user>请解释光合作用。</user><assistant>光合作用是...过程。<eos>`

`EOS` is important for both:

- teaching answer boundary during training
- stopping generation during inference

#### 3) Generation stop condition

Prompt:

`地球为什么有四季？`

Without EOS-stop, generation may continue to `max_new_tokens`.  
With EOS-stop, output is usually cleaner and shorter.

#### 4) Sample packing

To improve throughput, short texts are often packed:

`勾股定理描述直角三角形边长关系。<eos>元素周期表按原子序数排列。<eos>`

This uses context window efficiently while preventing sample contamination.

#### 5) When BOS can be omitted

For Chinese continuation tasks with non-empty prompts:

`请续写：量子力学是研究微观粒子行为的理论，`

Many models work without explicit BOS.  
But EOS is still strongly recommended (boundary + stop).

---

## 预训练问题排查总结（中文）

### 现象

- 在训练进度到约 55% 时，日志中的 `loss` 仍在 `46.7` 左右，感觉像“几乎不下降”。
- 同时生成质量一般，存在重复或边界不清的问题。

### 核心结论

模型并没有明显“坏掉”，数据也不是单一灾难性错误；主要是**日志读法 + 训练配置细节**共同导致“看起来 loss 卡住”。

### 1) 为什么会看到 `46.7`：这是被梯度累积放大的显示值

当前配置里 `gradient_accumulation_steps=6`。训练日志中的 `loss` 在该版本 Trainer 下会受到累积方式影响，数值常接近“真实 token loss 的 6 倍”。

- 经验换算：`46.7 / 6 ~= 7.8`
- 而日志里的 `eval_loss` 约为 `7.786`，与换算后的训练损失一致

因此 `46.7` 不能直接当作“真实每 token 交叉熵”去解读。判断收敛应优先看 `eval_loss`。

### 2) 为什么中后期像平台期：学习率进入尾段

日志显示继续训练来自较晚检查点，学习率一路衰减到极小值（接近 `1e-8` 量级）。此时参数更新幅度很小，损失下降自然变慢，表现为平台期。

这属于调度尾段现象，不是模型结构崩溃。

### 3) 代码中值得修复的两个关键点

#### A. `model.py` 中 dropout 被配置覆盖为 0

`DecoderOnlyModel` 初始化里：

- 传入了 `dropout=0.1`
- 但随后用 `config.attention_dropout` 覆盖
- `Qwen2Config` 默认该值常为 `0.0`

结果是实际 dropout 可能被静默置零，削弱正则化。

#### B. `pretrain.py` 中将 `pad_token` 设为 `eos_token`

`DataCollatorForLanguageModeling(mlm=False)` 会把 pad 位标签置为 `-100`。若 `pad_token_id == eos_token_id`，会把 EOS 监督信号一并屏蔽，影响模型学习“结束”行为。

建议使用独立 `pad_token`，避免与 `eos_token` 共用 ID。

### 4) 数据侧还有一个常见质量点：样本边界

若打包/切块时未在文档边界显式插入 EOS，模型会学习到跨文档的伪连续性，影响困惑度和生成连贯性。应在样本边界插入 EOS 再进行 chunk/pack。

### 是否“模型或数据有问题”——最终判断

- **不是单点致命错误**，训练过程总体稳定。
- **确实有可优化问题**：损失解读方式、学习率尾段、dropout 覆盖、EOS 与 pad 冲突、边界处理。
- 当前 checkpoint 更像“中间态”，可继续优化后再训练，不建议直接当最终模型。

### 建议的下一步（按优先级）

1. 以 `eval_loss`（及 PPL）为主指标，不再直接用 `46.x` 判断是否收敛。  
2. 继续训练时采用“重启优化器/调度器”的方式（如 weights-only resume + 合理初始 LR）。  
3. 修复 dropout 覆盖逻辑，确保训练确实使用期望的 dropout。  
4. 使用独立 `pad_token`，避免屏蔽 EOS 监督。  
5. 确保文档边界插入 EOS 后再 tokenization/packing。  
