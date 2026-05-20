# Pretrain Loss Summary and Improvement Suggestions

## Current loss status

- Training completed successfully on A100 and did not diverge.
- Logged train loss stays around `46.x`, but this value is not directly comparable to eval loss because training logs are affected by gradient accumulation and logging style.
- Eval loss is around `7.8` near the end (`~1.99 epoch`), with only small improvement in this resumed segment.
- Generation quality is still weak (repetitive punctuation patterns), so this checkpoint is not yet a good final model.

## Overall judgment

- Stability: **acceptable**
- Convergence quality: **insufficient**
- Usability for final generation: **not ready**

## Most likely root causes

1. Training resumed from a late checkpoint (`checkpoint-4200` of `7034`), so much of this run is in the cosine LR tail.
2. LR decays to very small values near the end, limiting further quality gain.
3. Current logging makes train-loss trend hard to interpret.
4. Data quality/boundary/packing noise may contribute to repetitive generation.

## Suggestions to improve (priority order)

1. **Continue training with effective LR**
   - Use a refreshed schedule for continuation (or short constant-LR phase) instead of staying in near-zero LR tail.
   - Increase total training tokens/steps meaningfully.

2. **Track better metrics**
   - Use `eval_loss` (and perplexity) as primary signal.
   - Save/select best checkpoint by eval metric.
   - Add cleaner step logs (including normalized train loss).

3. **Improve data quality**
   - Deduplicate samples and reduce noisy punctuation-heavy text.
   - Ensure clear sample boundaries with EOS.
   - Spot-check tokenized chunks for abnormal patterns.

4. **Strengthen validation of generation**
   - Evaluate fixed prompts every eval checkpoint.
   - Compare checkpoints by both eval loss and qualitative outputs.

5. **Tune optimization carefully**
   - Keep effective batch stable.
   - If repetition persists, lower LR slightly and train longer rather than ending in a very low LR tail.

## Practical conclusion

Treat the current checkpoint as an intermediate result: training is stable, but language quality has not converged to a good level yet.

## Implemented now (data quality pipeline)

The following data-quality improvements have been implemented in `pretrain.py` before tokenization:

1. **Text normalization**
   - Trim leading/trailing whitespace.
   - Collapse repeated whitespace to single spaces.
   - Compress long repeated punctuation (e.g. `!!!!!!` -> `!!!`, `。。。。。` -> `。。。`).

2. **Low-quality sample filtering**
   - Remove empty texts.
   - Remove very short samples using `PRETRAIN_MIN_TEXT_CHARS` (default: `20`).
   - Remove punctuation-heavy samples using `PRETRAIN_MAX_PUNC_RATIO` (default: `0.40`).

3. **Exact deduplication (per split)**
   - Deduplicate normalized samples with SHA1 hash of text.
   - Keep only the first occurrence in each split.

4. **Traceable cleaning logs**
   - For each split (`train`/`test`), logs now include:
   - `before`, `after`, `removed`, `min_chars`, `max_punc_ratio`.

5. **Cache refresh to avoid stale token cache**
   - Token cache schema version is bumped to `full_chunk_ctx_v2_quality`.
   - This forces rebuild from cleaned data instead of reusing old cached tokens.

## Why this matters

- Reduces repetitive punctuation patterns in training data.
- Improves signal quality and sample diversity (via dedup).
- Makes data cleaning measurable and reproducible from logs.

## Latest code changes summary

The latest `pretrain.py` updates focus on making continuation training stronger and easier to tune:

1. **New CLI training knobs**
   - Added: `--context_length`, `--num_train_epochs`, `--learning_rate`, `--lr_scheduler_type`, `--warmup_ratio`, `--eval_steps`, `--save_steps`, `--max_grad_norm`.
   - These can also be controlled by matching env vars (`PRETRAIN_*`), then overridden by CLI.

2. **Default continuation strategy improved**
   - Default scheduler changed to `cosine_with_restarts` to avoid getting stuck in a near-zero-LR tail.
   - Default epochs increased to `4` for longer effective training.

3. **Context consistency fixed**
   - Tokenization `context_length` and model `max_position_embeddings` are now aligned via the same argument.
   - Avoids mismatch between data chunk length and model positional limit.

4. **Evaluation and checkpoint cadence made configurable**
   - `eval_steps` and `save_steps` are now explicit runtime knobs.
   - Makes it easier to get denser quality signals and better checkpoint selection.

5. **Run visibility improved**
   - Logs now print a compact hyperparameter summary at startup:
   - `context_length`, `epochs`, `lr`, `lr_scheduler`, `warmup_ratio`, `eval_steps`, `save_steps`.

## Train.log issues and how to fix

### 1) Issue: Eval loss improves too little, then plateaus

- Observed: `eval_loss` only moves slightly (about `7.805 -> 7.786`) and then flattens.
- Meaning: training is stable, but learning signal is weak in this segment.

**Fix**
- Train longer with a refreshed schedule (`--num_train_epochs 6` or higher).
- Prefer `--resume_weights_only` for continuation to restart optimizer/scheduler state.
- Keep frequent eval to verify real progress (`--eval_steps 50`).

### 2) Issue: Learning rate decays to near zero

- Observed: LR drops to around `4e-08` near the end.
- Meaning: parameter updates become too small to make meaningful gains.

**Fix**
- Use a non-dead-tail schedule for continuation: `--lr_scheduler_type cosine_with_restarts`.
- Keep a practical LR floor by restarting with `--resume_weights_only --learning_rate 5e-4`.
- Use warmup ratio instead of fixed warmup steps: `--warmup_ratio 0.03`.

### 3) Issue: Late-stage continuation dominates this run

- Observed: log segment is already at high epoch/step region.
- Meaning: this run spends much of the time in LR tail rather than effective learning phase.

**Fix**
- Continue from weights-only mode when quality stalls in tail.
- Run a fresh continuation window (more epochs) rather than tiny tail-only extension.

### 4) Issue: Raw train loss (`46.x`) is hard to interpret

- Observed: train loss appears nearly flat and not directly comparable across settings.
- Meaning: easy to misjudge model quality if only looking at train loss.

**Fix**
- Use `eval_loss` as primary convergence metric.
- Compare checkpoints by `best_eval_loss` and generation samples, not raw train loss alone.
- Keep checkpoint cadence steady (`--save_steps 100`) for easier checkpoint comparison.

### 5) Issue: Output quality still weak (repetition/noise)

- Observed: final generation quality is not yet production-ready.
- Meaning: convergence and/or data quality is still insufficient.

**Fix**
- Keep the implemented data-quality pipeline enabled (normalization/filtering/dedup).
- Optionally tighten quality thresholds:
  - `PRETRAIN_MIN_TEXT_CHARS=30`
  - `PRETRAIN_MAX_PUNC_RATIO=0.30`
- Re-train and re-check with `llm_test.py` plus eval loss trend.

## Recommended command (A100 continuation)

```bash
python edu_llm/pretrain.py --data_dir edu_llm --resume_weights_only --num_train_epochs 6 --learning_rate 5e-4 --lr_scheduler_type cosine_with_restarts --warmup_ratio 0.03 --eval_steps 50 --save_steps 100 --context_length 512
```

---

## Post tiger-4 run fixes (2026-05-20)

Analysis of the tiger-4 training log revealed four root-cause bugs and three
training configuration problems.  All have been fixed in `model.py` and
`pretrain.py`.

> **Architecture change notice:** Fixes 1–3 change the model's layer structure.
> Existing tiger-4 checkpoints (`checkpoint-*`) are incompatible and must be
> deleted before the next run.

---

### model.py — Fix 1: Embedding initialization (Critical)

**Problem:** `nn.Embedding` default initializes weights with `std=1.0`.
With `hidden_size=512` and weight-tied output projection the initial logit
variance is `≈ d_model = 512`, producing a max logit of `~110` over the
151k-token vocab.  This drove the **first-step train loss to ~564** (the
theoretical minimum for a random predictor is `ln(151648) ≈ 11.9`).
The loss curve then spent hundreds of steps simply recovering from the bad
start, wasting compute and obscuring real learning progress.

**Fix:** Scale embedding weights to `std=0.02` (GPT-2 convention) right after
weight tying.  Expected first-step loss after fix: `~12–14`.

```python
nn.init.normal_(self.emb.weight, mean=0.0, std=0.02)
```

---

### model.py — Fix 2: Post-LN → Pre-LN architecture (High)

**Problem:** The `DecoderLayer` used Post-LN (LayerNorm applied *after* the
residual add).  In Post-LN the un-normalised residual stream enters each
attention and FFN layer directly.  When an outlier batch arrives the large
residual magnitudes amplify gradients through the stack.  This is the root
cause of the **two loss spikes observed in tiger-4**:

| Epoch | Step | Train loss | Grad norm |
|---|---|---|---|
| 0.80 | ~1,400 | 81.9 | 21 |
| 0.91 | ~1,750 | 136.6 | 77 |
| 0.94 | ~1,800 | 145.8 | 79 |

**Fix:** Switch to Pre-LN (LayerNorm applied *before* attention/FFN).  The
residual stream is normalised at every layer input, bounding activations
regardless of what the previous layer produced.

```python
# Before (Post-LN)
attn_out, _ = self.self_attn(x, x, x, attn_mask=attn_mask)
x = self.norm1(x + attn_out)
x = self.norm2(x + self.ffn(x))

# After (Pre-LN)
normed = self.norm1(x)
attn_out, _ = self.self_attn(normed, normed, normed, attn_mask=attn_mask)
x = x + attn_out
x = x + self.ffn(self.norm2(x))
```

---

### model.py — Fix 3: Final LayerNorm after decoder stack (High)

**Problem:** Pre-LN models require an explicit final norm.  In Post-LN every
layer's *output* is normalised.  In Pre-LN only every layer's *input* is
normalised, so the last layer's output is a raw residual sum with no norm.
Without this fix `self.fc(h)` receives poorly-scaled hidden states from the
last layer.

**Fix:** Add `self.norm = nn.LayerNorm(d_model)` and apply it before the
output projection.

```python
# in __init__
self.norm = nn.LayerNorm(_d_model)

# in forward
logits = self.fc(self.norm(h))   # was: self.fc(h)
```

---

### model.py — Fix 4: Repetition penalty sign bug (Medium)

**Problem:** The `generate()` repetition penalty divided every repeated token's
logit by `penalty`.  For a *negative* logit, dividing by `penalty > 1` makes
the value *less* negative — it raises the token's probability instead of
lowering it.  Penalty was effectively inverted for low-probability tokens.

**Fix:** Apply the correct conditional: divide positive logits, multiply
negative logits.

```python
# Before (wrong for negative logits)
logits.scatter_(..., src=logits.gather(-1, tok) / repetition_penalty)

# After (correct)
score = logits.gather(-1, tok)
score = torch.where(score < 0, score * repetition_penalty, score / repetition_penalty)
logits.scatter_(..., src=score)
```

---

### pretrain.py — Fix 5: Generation test used wrong decoding function (High)

**Problem:** The post-training generation test called `_greedy_generate()`,
which does pure argmax with no repetition penalty.  Once the model assigned the
highest probability to `，` it stayed there indefinitely, producing
`人工智能，，，，，，，，`.  The `model.generate()` method — which already has
`repetition_penalty`, `temperature`, and top-p sampling — was never exercised.

**Fix:** Replace the test loop with a `model.generate()` call using
`temperature=0.8`, `top_p=0.9`, `repetition_penalty=1.3`.

---

### pretrain.py — Fix 6: Hard-coded 2 epochs (High)

**Problem:** `num_train_epochs=2` was hard-coded.  After 2 epochs the eval loss
was 7.77 (perplexity ~2,350 — a well-trained Chinese Wikipedia LM targets < 50)
with only 0.08 improvement across all of epoch 2.  The model had not converged.

**Fix:** Added `--num_epochs` CLI argument (default `10`).  The epoch count is
now explicit and controlled at launch time.

---

### pretrain.py — Fix 7: warmup too short, grad clipping implicit (Medium)

**Problem:** `warmup_steps=200` with better embedding init still benefits from
a longer ramp so AdamW's second-moment estimates can stabilise before peak LR.
`max_grad_norm` was left at the framework default (1.0) and was invisible in the
config, making it easy to accidentally remove.

**Fix:**
- `warmup_steps`: `200` → `500`
- `max_grad_norm=1.0` made explicit in `TrainingArguments`

---

### Summary table

| # | File | Severity | Problem | Fix |
|---|---|---|---|---|
| 1 | `model.py` | Critical | Embedding `std=1.0` → initial loss 564 | `nn.init.normal_(emb.weight, std=0.02)` |
| 2 | `model.py` | High | Post-LN causes loss spikes on outlier batches | Switch `DecoderLayer` to Pre-LN |
| 3 | `model.py` | High | No final norm after Pre-LN stack | Add `self.norm` + `fc(norm(h))` |
| 4 | `model.py` | Medium | Repetition penalty inverted for negative logits | `torch.where` sign-aware penalty |
| 5 | `pretrain.py` | High | Test used greedy argmax, bypassing `generate()` | Call `model.generate()` with sampling |
| 6 | `pretrain.py` | High | 2 epochs hard-coded, model not converged | `--num_epochs` arg, default 10 |
| 7 | `pretrain.py` | Medium | Warmup too short; grad clip implicit | `warmup_steps=500`, explicit `max_grad_norm=1.0` |
