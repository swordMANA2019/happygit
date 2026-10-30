# DataCleaner Quality Guide

How to run the test and interpret `datacleaner_quality.png`.

---

## Run the test

```bash
# Synthetic samples (no dataset needed)
python llm_test.py

# Real dataset, sample 5000 rows, save chart
python llm_test.py --data-file /path/to/wikipedia-zh-cn-20240820.json --sample-size 5000 --plot-dir ./plots
```

---

## Chart panels

### 1. Pass / Reject ratio (pie)

| Green slice | Verdict |
|---|---|
| > 80% | Good — cleaner is not over-filtering |
| 60–80% | Acceptable — investigate rejection reasons |
| < 60% | Bad corpus or thresholds too strict |

---

### 2. Rejection reasons (bar)

| Dominant reason | What it means |
|---|---|
| `too_short` | Many stubs / headings — normal for Wikipedia |
| `long_ngram_repeat` | Same 10-char substring repeated ≥3 times — common in edu/web text |
| `high_ngram_dup` | Repetitive / machine-generated spam — bad signal |
| `high_noise` | Encoding garbage or HTML remnants — needs upstream pre-processing |
| `low_punctuation` | Tables, lists, or code — not useful for LM training |
| `duplicate` | Large-scale duplication — clean more aggressively |

---

### 3. Text length distribution (before vs after)

| What you see | Verdict |
|---|---|
| Before and after bars overlap closely | Cleaner is gentle — good |
| After bars shift far left | Cleaner strips too much — check `_basic_clean` |
| Mean barely changes (e.g. 172 → 169) | Healthy, only junk was removed |
| Distribution peaks at 100–500 chars | Good for LLM training |
| Most samples < 40 chars | Corpus is mostly fragments — poor training data |

---

### 4. Noise ratio

| What you see | Verdict |
|---|---|
| All passed (green) bars left of 0.15 threshold | Normal — cleaner works correctly |
| Green bars spread past 0.15 | Bug — noisy text slipping through |
| All samples near 0.0 | Excellent corpus, almost no symbol noise |
| Red bars far right (0.5–1.0) | Garbage correctly rejected |

---

### 5. N-gram repetition

| What you see | Verdict |
|---|---|
| Green bars all left of 0.35 threshold | Good — passed text is not repetitive |
| Red bars right of 0.35 | Repeating filler correctly caught |
| Green bars between 0.2–0.35 | Borderline — consider tightening threshold |
| Everything near 0.0–0.1 | Excellent natural-language diversity |

---

### 6. Punctuation density

| What you see | Verdict |
|---|---|
| Green bars between 0.02 and 0.20 | Normal prose, well-structured sentences |
| Green bars piling up near 0.02 | Marginal quality — text is barely punctuated |
| Green bars above 0.20 | Over-punctuated (legal text, dialogue) — usually fine |
| Red bars below 0.02 | Lists / bare noun sequences correctly dropped |

---

## Overall health checklist

Run against the real dataset and verify all five:

1. **Pie** — green slice > 75%
2. **Rejection bar** — `too_short` is the only large bar; all others are small
3. **Length** — before/after means differ by less than 5%
4. **Noise** — all green bars clustered near 0.0, well left of the 0.15 line
5. **N-gram dup** — all green bars clustered near 0.0–0.1, well left of the 0.35 line

If all five pass → data and cleaner are both healthy.  
If any one fails → the corpus or the threshold for that metric needs attention.

---

## Science pretrain corpus analysis

Evaluated: `data/pretrain/*.json` from `download_science.py` (37,755 articles, ~177 MB, 9 topic files).

### Corpus overview

| Metric | Value |
|--------|-------|
| Articles | 37,755 |
| Sources | `chinese_edu_web` 53% / `wikipedia_zh` 47% |
| Length (chars) | min 200, median 1,134, mean 1,887 |
| JSON record | `{"source_id": "...", "source_row": N, "text": "..."}` |

### `pretrain.py` compatibility

| Item | Status |
|------|--------|
| Required file | `data_dir/wikipedia-zh-cn-20240820.json` (single merged JSON) |
| Topic files | Must merge 9 `*.json` files before training |
| `clean_data()` retention | **65.3%** (24,662 / 37,755) — borderline (target > 75%) |
| Scale vs Wikipedia | ~25k articles vs ~1.2M — **~2%** of prior Wikipedia run |

**Verdict:** Good for pipeline smoke test and science-domain experiment; **not enough volume** for full pretrain comparable to Wikipedia. Merge JSON, then run `pretrain.py --data_dir <pretrain_dir>`.

### Rejection breakdown (pre-dedup)

| Reason | Count | % | Priority |
|--------|-------|---|----------|
| `long_ngram_repeat` | 12,742 | **33.7%** | Fix this |
| `high_noise` | 196 | 0.5% | Low |
| `low_punctuation` | 133 | 0.4% | Low |
| Other | 18 | ~0% | — |

Pass rate by source: `chinese_edu_web` 68.3%, `wikipedia_zh` 62.0%.

---

## `long_ngram_repeat` — what it is and how to fix

### Definition

Implemented in `common.py` → `has_ngram_repeat()`:

1. Slide a window of **n = 10** characters across the text.
2. Count how many times each 10-char substring appears.
3. If **any** substring appears **≥ 3 times** (`NGRAM_REPEAT_LIMIT`) → reject.

Catches copy-paste / template spam, but also rejects normal Chinese edu/web prose where short phrases repeat in different contexts.

### Example

Text: `今天天气很好，今天天气很好，今天天气很好。`

The 10-gram `天气很好，今天天气` appears **3 times** → **rejected**.

Encyclopedic text with diverse wording → usually **passes**.

### Fix comparison (measured on current corpus)

| Config | Reject rate | Pass rate |
|--------|-------------|-----------|
| Current `n=10, th=3` | 35.2% | 64.8% |
| `n=10, th=4` | 19.7% | 80.3% |
| **`n=12, th=4`** | **12.7%** | **87.3%** |
| `n=15, th=3` | 14.0% | 86.0% |
| Ratio-based (`r=0.08`) | ~0% | ~100% (too weak) |

### Recommended fix

**Best for this corpus:** `n=12`, `threshold=4` in `common.py`.

```python
NGRAM_REPEAT_LIMIT = 4   # was 3

def has_ngram_repeat(text, n=12, threshold=NGRAM_REPEAT_LIMIT):  # was n=10
    ...
```

Why: edu/science text legitimately reuses terms (`小麦`, `化学`, `农业`); requiring **12 identical chars × 4 occurrences** catches real loops without dropping normal articles. Expected overall retention: **~85–88%**.

Simpler alternative (one-line): `NGRAM_REPEAT_LIMIT = 4` with `n=10` → ~80% pass on this filter.

Do **not** use ratio-only rules on this corpus — they reject almost nothing.

---

## Minor filters (`high_noise`, `low_punctuation`)

Both affect **< 1%** of articles — low priority.

| Filter | Rule | Typical cause | Optional fix |
|--------|------|---------------|--------------|
| `high_noise` | Illegal chars > 15% | Science symbols `×°%±`, Greek letters | Whitelist symbols in `noise_pattern` or normalize in `_basic_clean()` |
| `low_punctuation` | Punct < 2% of chars | Lists, headings without `。，` | Lower threshold to 0.015, or convert `\n` → `。` in `_basic_clean()` |

---

## Merge topic files for `pretrain.py`

```powershell
Get-ChildItem C:\Users\jiuling\Documents\data\pretrain\*.json |
  Where-Object { $_.Name -ne 'science_state.json' } |
  ForEach-Object { Get-Content $_.FullName } |
  Set-Content C:\Users\jiuling\Documents\data\pretrain\wikipedia-zh-cn-20240820.json

python edu_llm/pretrain.py --data_dir C:\Users\jiuling\Documents\data\pretrain --num_epochs 10
```

Re-check quality after any `common.py` change:

```bash
python llm_test.py --data-file /path/to/wikipedia-zh-cn-20240820.json --sample-size 5000 --plot-dir ./plots
```

---

## Getting more training data

Current science corpus (~37k articles, ~177 MB) is far below prior Wikipedia pretrain (~1.2M articles). The downloader also caps each topic file at **20 MB** — most files are already full.

### Why volume is limited

| Bottleneck | Effect |
|------------|--------|
| `MAX_FILE_BYTES = 20 MB` | 9 topics × 20 MB ≈ **180 MB max**; full files stop accepting writes |
| Topic classifier | Many scanned rows do not match any science topic |
| `--articles 2000` (default) | Small batch per run |
| `chinese_edu_web` | Only **35** parquet shards loaded (not full 10.5M-row dataset) |
| `cci3_hq` | Skipped without `HF_TOKEN` |

### Option 1 — More from `download_science.py`

| Action | How |
|--------|-----|
| Raise per-topic cap | `MAX_FILE_BYTES = 100 * 1024 * 1024` in `download_science.py` → ~900 MB total |
| Larger batches | `--articles 50000` (repeat until `--status` shows progress stalling) |
| More edu-web shards | Increase `DOWNLOAD_PARQUET_NUM` (default 35) in `_load_hf_dataset()` |
| Enable CCI3-HQ | Set `HF_TOKEN`, then run download |
| Looser classification | `--min-topic-score 3 --min-score-margin 1` |

```powershell
python edu_llm/download_science.py --output-dir C:\Users\jiuling\Documents\data\pretrain --articles 50000
python edu_llm/download_science.py --output-dir C:\Users\jiuling\Documents\data\pretrain --status
```

### Option 2 — Mix science + full Wikipedia (recommended for serious pretrain)

Science JSON alone is too small for general LM pretrain. Blend with full Chinese Wikipedia:

| Component | Role |
|-----------|------|
| Full `wikipedia-zh-cn-*.json` | Bulk language modeling (~1.3M articles) |
| Science topic JSON | Domain boost (chemistry, physics, biology, …) |

```powershell
# Merge science topic files
Get-ChildItem C:\Users\jiuling\Documents\data\pretrain\*.json |
  Where-Object { $_.Name -notmatch 'science_state|wikipedia-zh' } |
  ForEach-Object { Get-Content $_.FullName } |
  Set-Content C:\Users\jiuling\Documents\data\pretrain\science_merged.json

# Concat with Wikipedia (adjust Wikipedia path)
Get-Content C:\path\to\wikipedia-zh-cn-20240820.json, C:\Users\jiuling\Documents\data\pretrain\science_merged.json |
  Set-Content C:\Users\jiuling\Documents\data\pretrain\wikipedia-zh-cn-20240820.json
```

### Option 3 — Additional sources

| Source | Size | In script |
|--------|------|-----------|
| `wikimedia/wikipedia` | ~1.3M | Active |
| `opencsg/chinese-fineweb-edu` | 10.5M+ rows | Active (partial shards) |
| `BAAI/CCI3-HQ` | Large | Needs `HF_TOKEN` |
| `allenai/c4` zh | ~33 GB | Commented out — re-enable in `SOURCES` |

### Scale reference

| Corpus | Articles (after clean, approx.) | Use case |
|--------|----------------------------------|----------|
| Science JSON now | ~25k | Pipeline smoke test |
| Science at 100 MB/topic | ~150k–200k | Small science-biased LM |
| Science + Wikipedia | ~1.2M+ | Real pretrain |
| Full FineWeb-Edu + Wiki | Millions | Large-scale |

### Recommended path

| Goal | Action |
|------|--------|
| Quick improvement | Raise cap to 100 MB + `--articles 50000` + more parquet shards |
| Serious pretrain | **Wikipedia (full) + science JSON merged** |
| Science specialist | Above + `HF_TOKEN` for CCI3 + slightly relaxed `--min-topic-score` |
