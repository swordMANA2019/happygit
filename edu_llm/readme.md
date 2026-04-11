## Basic usage

```bash
python pretrain.py --data_dir /home/tliang/tl_build/data --train_batch_size 8 --eval_batch_size 4
```

## Continue training options

- Default behavior: resume full checkpoint state (model + optimizer + scheduler).
- Use `--resume_weights_only` to load only model weights from latest checkpoint and restart optimizer/LR schedule.

```bash
python pretrain.py --data_dir /home/tliang/tl_build/data --resume_weights_only
```

## How to read logs

- `loss`: raw trainer logged loss.
- `normalized_loss`: `loss / grad_accum`, better for comparing runs.
- `effective_batch_size`: `train_batch_size * grad_accum` (single GPU).
- `eval_loss` and `perplexity`: primary quality indicators.
- `best_eval_loss` and `best_model_checkpoint`: best checkpoint summary at end.
