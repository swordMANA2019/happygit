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
