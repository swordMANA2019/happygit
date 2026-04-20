## Basic usage

```bash
python edu_llm/pretrain.py --data_dir edu_llm
```

## Continue training options

- Default behavior: resume full checkpoint state (model + optimizer + scheduler).
- Use `--resume_weights_only` to load only model weights from latest checkpoint and restart optimizer/LR schedule.

```bash
python edu_llm/pretrain.py --data_dir edu_llm --resume_weights_only
```

## Recommended A100 command

```bash
python edu_llm/pretrain.py --data_dir edu_llm --resume_weights_only --num_train_epochs 6 --learning_rate 5e-4 --lr_scheduler_type cosine_with_restarts --warmup_ratio 0.03 --eval_steps 50 --save_steps 100 --context_length 512
```

## Tune data quality (optional)

```bash
# PowerShell example
$env:PRETRAIN_MIN_TEXT_CHARS="20"
$env:PRETRAIN_MAX_PUNC_RATIO="0.40"
python edu_llm/pretrain.py --data_dir edu_llm
```

## Main training knobs

- `--context_length`: token chunk length for pretraining.
- `--num_train_epochs`: total training epochs.
- `--learning_rate`: peak/base LR used by scheduler.
- `--lr_scheduler_type`: e.g. `cosine`, `cosine_with_restarts`.
- `--warmup_ratio`: warmup fraction of total steps.
- `--eval_steps`: evaluation frequency.
- `--save_steps`: checkpoint save frequency.
- `--max_grad_norm`: gradient clipping threshold.

## Environment variable overrides

- `PRETRAIN_CONTEXT_LENGTH`
- `PRETRAIN_NUM_TRAIN_EPOCHS`
- `PRETRAIN_LEARNING_RATE`
- `PRETRAIN_LR_SCHEDULER_TYPE`
- `PRETRAIN_WARMUP_RATIO`
- `PRETRAIN_EVAL_STEPS`
- `PRETRAIN_SAVE_STEPS`
- `PRETRAIN_MAX_GRAD_NORM`
- `PRETRAIN_MIN_TEXT_CHARS`
- `PRETRAIN_MAX_PUNC_RATIO`

CLI values take priority over environment values.

## How to read logs

- `loss`: raw trainer logged loss (not the best cross-run comparator when accumulation changes).
- `effective_batch_size`: `train_batch_size * grad_accum` (single GPU).
- `eval_loss`: primary convergence signal for model quality.
- `best_eval_loss` and `best_model_checkpoint`: best checkpoint summary at end.
- `数据清洗[train/test]`: before/after/removed counts from quality filtering and dedup.

## Quick model test after training

```bash
python edu_llm/llm_test.py --data_dir edu_llm --max_new_tokens 64
```
