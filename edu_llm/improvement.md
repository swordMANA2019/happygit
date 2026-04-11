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
