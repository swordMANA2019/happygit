# Bug Fix Summary

Bugs found during post-pretrain generation quality review.  
Files changed: `model.py`, `pretrain.py`.

---

## Bug 1 — model.py: Model built with half the intended depth (Critical)

**File:** `model.py`  
**Symptom:** Model always has 6 decoder layers regardless of config, even when `num_hidden_layers=12` is specified. Silently halves model capacity with no error or warning.

**Root cause:**  
`range(num_layers)` in the `nn.ModuleList` comprehension used the raw constructor parameter (`num_layers`, default `N_LAYERS=6`) instead of `_nlayers`, which is the local variable correctly updated from `config.num_hidden_layers`.

```python
# Before (wrong): always uses parameter default = 6
for _ in range(num_layers)

# After (fixed): uses value from config
for _ in range(_nlayers)
```

---

## Bug 2 — model.py: Typo causes intermediate_size to never read from config (Medium)

**File:** `model.py`  
**Symptom:** `config.intermediate_size` is never applied. The FFN width always falls back to `d_model * 4` using the constructor parameter `d_model` (default `HIDDEN_SIZE=512`), not the config value.

**Root cause:**  
A missing letter in the local variable name: `_ntermediate_size` was assigned instead of `_intermediate_size`, leaving `_intermediate_size` unchanged.

```python
# Before (wrong): dead variable, _intermediate_size not updated
_ntermediate_size = getattr(config, "intermediate_size", None)

# After (fixed):
_intermediate_size = getattr(config, "intermediate_size", None)
```

In the current configuration (`hidden_size=512`, `intermediate_size=2048`) the fallback `512 * 4 = 2048` happens to match, so this bug had no visible effect yet. It is a latent correctness trap for any config where `intermediate_size != hidden_size * 4`.

---

## Bug 3 — pretrain.py: pad_token = eos_token kills EOS supervision (High)

**File:** `pretrain.py`  
**Symptom:** Model never learns to stop generating. After pretraining, generation runs to `max_new_tokens` instead of halting at natural sentence/document endings.

**Root cause:**  
`DataCollatorForLanguageModeling` replaces every pad token's label with `-100` (ignored in loss). Because `tokenizer.pad_token` was set to `tokenizer.eos_token`, all `<eos>` tokens in every training sequence were also masked out. The model never received a gradient signal for the stop token.

```python
# Before (wrong): EOS and pad share the same ID
tokenizer.pad_token = tokenizer.eos_token

# After (fixed): dedicated pad token, EOS supervision preserved
if tokenizer.pad_token is None or tokenizer.pad_token_id == tokenizer.eos_token_id:
    tokenizer.add_special_tokens({"pad_token": "<|pad|>"})
```

The `Qwen2Config` is also updated with `pad_token_id=tokenizer.pad_token_id` so the config is consistent.

---

## Bug 4 — model.py: Embedding dropout silently zeroed by config (Low)

**File:** `model.py`  
**Symptom:** `self.dropout` (applied after the token embedding) always has `p=0.0` when a `Qwen2Config` is passed, regardless of the `dropout=0.1` argument. Regularisation for the embedding layer is disabled.

**Root cause:**  
`_dropout` was unconditionally overwritten with `config.attention_dropout`, which defaults to `0.0` in `Qwen2Config`. The caller's `dropout` argument was silently discarded.

```python
# Before (wrong): Qwen2Config default attention_dropout=0.0 overwrites caller's 0.1
_dropout = getattr(config, "attention_dropout", dropout)

# After (fixed): only override if config explicitly sets a positive dropout
config_attn_dropout = getattr(config, "attention_dropout", None)
if config_attn_dropout is not None and config_attn_dropout > 0.0:
    _dropout = config_attn_dropout
```

---

## Bug 5 — pretrain.py: No EOS token at document boundaries (Medium)

**File:** `pretrain.py`  
**Symptom:** The model learns false cross-document continuity. When given a topic word like "北京市" as a prompt it generates content that looks like a different Wikipedia article (e.g. content about "台南市"), because during training document boundaries were invisible — consecutive 512-token chunks from different articles looked identical to one long mid-document stream.

**Root cause:**  
The `tokenize` function did not append `<eos>` before chunking each article. Each 512-token chunk was raw mid-article text with no boundary marker.

```python
# Before (wrong): no document boundary
outputs = tokenizer(element["text"], ...)

# After (fixed): EOS appended to each article before chunking
texts_with_eos = [t + tokenizer.eos_token for t in element["text"]]
outputs = tokenizer(texts_with_eos, ...)
```

---

## Not a Bug: "人工智能 → ，" is expected pretrain behaviour

Generating `，` or `（` after "人工智能" is **correct next-token prediction** for a model trained on Chinese Wikipedia. In Wikipedia, "人工智能" almost always appears as:

> 人工智能（英语：Artificial Intelligence，缩写为 AI）是…

A pretrained model predicts the Wikipedia distribution, not question answers. To get answering behaviour, **SFT (instruction fine-tuning) on Q&A data is required** after pretraining. The pretrain phase itself is working as intended.

---

## Change Summary

| # | File | Severity | Fixed |
|---|------|----------|-------|
| 1 | `model.py` | Critical | `range(num_layers)` → `range(_nlayers)` — model now builds correct number of layers |
| 2 | `model.py` | Medium | `_ntermediate_size` typo → `_intermediate_size` — config intermediate_size now applied |
| 3 | `pretrain.py` | High | Dedicated `<\|pad\|>` token added; EOS supervision no longer masked out |
| 4 | `model.py` | Low | Embedding dropout no longer zeroed by Qwen2Config attention_dropout default |
| 5 | `pretrain.py` | Medium | EOS appended to each article before tokenization; document boundaries now visible |
