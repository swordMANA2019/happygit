# Pretraining Analysis — run `tiger-4`

**Run date:** 2026-05-19 22:08 → 2026-05-20 03:44  
**Total wall time:** ~5 h 36 min (19,475 s)  
**SwanLab:** https://swanlab.cn/@swanlab01/WikiLLM/runs/6qbdr3irg0gsxntstdph7

---

## 1. Run configuration

| Item | Value |
|---|---|
| Model parameters | 115.6 M |
| Dataset (before cleaning) | train 1,292,828 / test 143,648 |
| Dataset (after cleaning) | train 1,066,718 / test 118,562 |
| Data retention rate | **82.5%** (good — cleaner not over-filtering) |
| Train batch size | 24 |
| Gradient accumulation | 6 |
| **Effective batch size** | **144** |
| Total steps | 3,502 |
| Epochs completed | **2.0** |
| LR schedule | Linear warmup (~400 steps) → cosine decay |
| Peak LR | 5.0 × 10⁻⁴ |
| Final LR | ~1.1 × 10⁻⁸ (effectively 0) |

---

## 2. Loss curve

### Train loss

| Epoch | Step | Loss | Note |
|---|---|---|---|
| 0.03 | ~50 | 564.6 | Random-init baseline |
| 0.17 | ~300 | 93.3 | Still in LR warm-up |
| 0.20 | ~400 | 69.2 | Warm-up ends, fast drop |
| 0.29 | ~500 | 60.4 | Plateau begins |
| 0.51 | ~900 | 47.8 | Stable zone ~47–49 |
| 0.80 | ~1,400 | **81.9** | ⚠️ Spike #1 |
| 0.91–0.94 | ~1,700–1,800 | **137–146** | ⚠️ Spike #2 (largest) |
| 1.0 | ~1,900 | 47.8 | Recovered |
| 1.43 | ~2,500 | 46.7 | Slow decline |
| 2.0 | 3,502 | **46.6** | Final |

**Final average train loss (reported by Trainer): 69.23** — inflated by the large early losses and the two spike events.

### Eval loss

| Step | Epoch | Eval loss |
|---|---|---|
| 500 | 0.29 | 8.387 |
| 1,000 | 0.57 | 7.989 |
| 1,500 | 0.86 | 7.852 |
| 2,000 | 1.14 | 7.807 |
| 2,500 | 1.43 | 7.787 |
| 3,000 | 1.71 | 7.776 |
| 3,502 | 2.00 | **7.770** |

Eval loss fell consistently but the improvement rate slows sharply after step 1,500 — only **0.08 drop across the entire second epoch**.

---

## 3. Chart-by-chart reading

### train/loss
Fast exponential drop from 564 → ~50 in the first 500 steps. Two visible spikes around steps 1,400 and 1,700. After step 2,000 the curve flattens near 46–47 with no further meaningful descent — the model has stalled.

### train/grad_norm
Starts at 200–300 with large oscillations (model is far from a good optimum). Gradually tames after step 1,000. Spikes at steps ~850 (259) and ~1,650 (79) correlate directly with the train loss spikes — these are the same problematic batches. After step 2,000 grad_norm drops below 20 and ends near **4** — the model is training stably in epoch 2.

### train/learning_rate
Correct warmup-then-cosine shape. Peak 5 × 10⁻⁴ at step ~400, smooth cosine decay to near zero at step 3,500. Schedule executed correctly.

### train/epoch  
Perfectly linear — confirms no data loading stalls or dropped steps.

### train/global_step  
Also linear — training proceeded at a steady ~4.6 s/step throughout.

---

## 4. Issues found

### Issue 1 — Loss spikes at epoch 0.80 and 0.91–0.94 ⚠️

Train loss jumped from ~47 to **82** (epoch 0.80) and then **137 → 146** (epoch 0.91–0.94), accompanied by grad_norm spikes of 21 and 77–79 respectively. The model recovered within 1–2 batches after each spike.

**Likely cause:** A few abnormally long or noisy samples that passed the DataCleaner. A single outlier batch can temporarily dominate the loss when the effective batch size is 144. The spike at epoch 0.91–0.94 is especially large (3× normal loss) and suggests two consecutive bad batches.

**Recommended fix:**
- Add a per-sample loss clipping or weight capping in the DataCollator
- Or tighten DataCleaner thresholds and re-run cleaning to remove borderline samples
- Inspect the raw samples around dataset index ~(0.91 × 1,066,718) ≈ row 970,000

### Issue 2 — Generation output is degenerate 🔴

```
人工智能: 人工智能，，，，，，，，，，，，，，，，，，，，，，，，，，，
牛顿:     牛顿，，，，，，，，，，，，，，，，，，，，，，，，，，，，，，
```

The model outputs the prompt token followed by nothing but repeated commas — a classic **degenerate repetition** pattern.

**Root causes:**
1. **Only 2 epochs** — a 115 M parameter model on 1 M Wikipedia articles needs more exposure to learn meaningful patterns.
2. **Eval loss 7.77** corresponds to a perplexity of e^7.77 ≈ **2,350**. A well-trained LM on clean Chinese Wikipedia would have perplexity under 50. The model has barely started to learn.
3. **No repetition penalty** in the generation call — once the model assigns high probability to comma (the most frequent punctuation), greedy decoding locks onto it.

**Recommended fixes:**
- Short-term: add `repetition_penalty=1.3` and `temperature=0.8` to the generation call in `pretrain.py`
- Medium-term: train for at least 10–20 epochs, or use more data
- Long-term: increase model capacity (more layers/hidden size) to better utilise the dataset

### Issue 3 — Train/eval loss gap ⚠️

Train loss at end: **~46.6** vs eval loss **7.77**. This unusually large gap suggests the train loss is reported as a **sum over tokens in the batch** (not mean), while eval loss is per-token. This is a reporting artefact rather than true overfitting. However it makes the SwanLab train/loss chart hard to interpret directly — confirm the loss reduction mode in `model.py`.

---

## 5. What went well ✅

- Data cleaning retained 82.5% of samples — appropriate, not over-aggressive
- Loss fell 12× from random init (564 → 46.6) within 2 epochs
- Grad norm stabilised from 300 → 4 — training is numerically healthy
- LR schedule executed correctly
- No OOM crashes, no stalls; training completed cleanly in 5.5 h

---

## 6. Recommended next steps

| Priority | Action |
|---|---|
| 🔴 High | Add `repetition_penalty` and `temperature` to the inference call |
| 🔴 High | Train for more epochs (target: eval loss < 3.0) |
| 🟡 Medium | Investigate and filter the ~2 noisy batches causing the loss spikes |
| 🟡 Medium | Confirm whether train loss is sum vs mean; align reporting |
| 🟢 Low | Try a larger model (e.g. hidden_size=768, num_layers=16) for better capacity |
| 🟢 Low | Add gradient clipping (`max_grad_norm=1.0`) to dampen future spikes |
