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
