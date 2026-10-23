### Model :

# ML Model — XGBoost LambdaMART Ranker

A **learning-to-rank** model: given a list of astrologers shown to a user, it
predicts the order that is most likely to lead to a click, booking or completed
consultation.

| | |
|---|---|
| Model | XGBoost `XGBRanker` |
| Algorithm | LambdaMART (gradient-boosted decision trees + LambdaRank) |
| Objective | `rank:ndcg` |
| Metric | NDCG@10 |
| Input | 47 numeric features per astrologer |
| Output | a relevance score (margin) per astrologer; higher = rank higher |

---

## 1. Problem framing

Ranking, not classification. The model doesn't ask "will this astrologer be
booked?" in isolation; it asks "**within this list**, which astrologer should be
above which?".

* **Query group** = one list served to one user (`qid`).
* **Item** = one astrologer in that list.
* **Label** = how relevant that astrologer turned out to be for that user.

The model only compares items inside the same group.

---

## 2. Labels (graded relevance)

| Label | Outcome |
|---|---|
| **3** | completed consultation |
| **2** | booked |
| **1** | clicked |
| **0** | shown, no action |

Higher labels matter more: NDCG gain is `2^label − 1`, so a completed
consultation (gain 7) is worth far more than a click (gain 1).

---

## 3. Features (47)

| Group | Features |
|---|---|
| Profile | `rating`, `reviewCount`, `experienceYears`, `verified`, `ageDays`, `isNew`, `consultationModeCount`, `specializationCount` |
| Price / economics | `pricePerMinute`, `priceBand`, `payoutPerMinute`, `marginRate`, `minCallMinutes`, `revenuePerImpression` |
| Availability | `isOnline`, `isBusy`, `hoursSinceActive`, `responseRate` |
| Request match | `languageOverlap`, `categoryMatch` |
| Observed performance | `impressions`, `clicks`, `completedCalls`, `ctr`, `clickToCallRate`, `conversionRate`, `repeatRate`, `avgCallMinutes`, `observedRating`, `observedRatingCount`, `complaintRate` |
| User personalisation | `userIsReturning`, `isFavorite`, `userCallsWithAstrologer`, `daysSinceUserLastCall`, `userTypicalPricePerMinute`, `priceDeltaRatio` |
| Rule-based scores | `s_qualityScore`, `s_personalizationScore`, `s_businessScore`, `s_priceScore`, `s_categoryScore`, `s_availabilityScore`, `s_explorationScore`, `s_languageScore`, `s_diversityScore`, `l2_totalScore` |

* **Missing values** (`null`) are allowed; each tree split learns a default
  direction for them.
* **Position is not a feature**, so the model can't learn "top items get
  clicked" (position bias) instead of real relevance.
* Feature values are recorded **at the moment the list was shown**, so the
  model never sees information from the future (no leakage).

---

## 4. Algorithm — how LambdaMART learns

### 4.1 Gradient-boosted trees

The model is a sum of small decision trees:

```
score(x) = base_score + tree₁(x) + tree₂(x) + … + treeₙ(x)
```

Trees are added one at a time. Each new tree is fitted to the **remaining
ranking errors** of the trees before it, and its contribution is scaled down by
the learning rate.

### 4.2 LambdaRank objective

For every pair (A, B) in the same list where A has a higher label than B:

1. If the model scores B ≥ A, the pair is ordered wrong.
2. The pair's gradient ("lambda") pushes A's score up and B's down.
3. Each pair is weighted by **|ΔNDCG|**, i.e. how much NDCG would change if
   A and B swapped places.

So mistakes near the top of the list (which users actually see) cost far
more than mistakes at position 40.

`lambdarank_pair_method="topk"` with `lambdarank_num_pair_per_sample = k`
concentrates pairs on the top-k positions.

### 4.3 Tree building

Each tree splits on features (`x[f] < threshold`) to group items with similar
gradients; leaf values are the score adjustments. `tree_method="hist"`
buckets feature values into histograms for fast split search.

---

## 5. Training procedure

1. **Group** rows by `qid`; keep lists with ≥ 2 items; sort lists by time.
2. **Minimum data:** ≥ 200 lists and ≥ 30 lists with any positive label.
3. **Time-based split:** oldest **80%** of lists → train, newest **20%** →
   validation. This tests whether the model predicts the *future*, which is
   how it's used.
4. **Fit** with early stopping on validation NDCG@10.
5. **Keep the best trees:** the model is trimmed to the iteration with the
   best validation score.
6. **Compare with the baseline:** validation NDCG@10 of the model vs the
   order that was actually served.
7. **Accept** only if the model beats the baseline.

---

## 6. Hyper-parameters

| Parameter | Value | Effect |
|---|---|---|
| `n_estimators` | 400 | maximum number of trees |
| `learning_rate` | 0.05 | shrinks each tree's contribution; lower = slower, steadier learning |
| `max_depth` | 6 | maximum tree depth; deeper = more feature interactions, more overfitting risk |
| `min_child_weight` | 1.0 | minimum evidence a leaf needs |
| `subsample` | 0.8 | each tree trains on a random 80% of rows |
| `colsample_bytree` | 0.8 | each tree uses a random 80% of features |
| `reg_lambda` | 1.0 | L2 penalty on leaf values |
| `early_stopping_rounds` | 40 | stop after 40 trees with no validation gain |
| `eval_metric` | `ndcg@10` | what early stopping watches |
| `random_state` | 42 | reproducible results |

**Learning rate × number of trees** go together: a smaller learning rate
needs more trees to reach the same fit, but usually generalises better.

---

## 7. Overfitting and underfitting

```
NDCG
 │            train ─────────────────────────────
 │         ╱‾‾‾‾‾‾‾
 │       ╱    validation ╱‾‾‾‾╲___
 │     ╱              ╱          ‾‾‾‾╲___   ← overfitting
 │   ╱             ╱
 │ ╱  underfitting
 └──────────────────────┬──────────────────── trees
                     best iteration (kept)
```

| | Overfitting | Underfitting |
|---|---|---|
| What happens | memorises training lists, including noise | too simple to capture the signal |
| Symptom | train NDCG keeps rising, validation falls | validation NDCG near / below the served order |
| Causes | too many trees, deep trees, small data | too few trees, very low learning rate, weak features, too little data |
| Controls here | early stopping, `subsample`, `colsample_bytree`, `max_depth`, `reg_lambda`, `min_child_weight` | more trees / higher learning rate / deeper trees, more data |
| Safety net | best-iteration trimming | model rejected if it doesn't beat the baseline |

**Tuning guide**

| Observation | Try |
|---|---|
| Validation peaks after very few trees | lower `learning_rate` (0.02) and/or collect more data |
| Validation drops while train rises | `max_depth` 4, lower `subsample`/`colsample_bytree` (0.7), higher `reg_lambda` |
| Model barely beats or loses to the baseline | more data with outcomes; then deeper trees or more rounds |
| Results jump a lot between runs | more validation lists; average over several seeds |

---

## 8. Evaluation — NDCG@k

```
DCG@k  = Σ_{i=1..k} (2^labelᵢ − 1) / log₂(i + 1)
NDCG@k = DCG@k(model order) / DCG@k(ideal order)
```

* 1.0 = perfect order, 0 = no relevant item in the top k.
* `log₂(i + 1)` discounts lower positions, so the top of the list dominates.
* Lists with no positive label are skipped (their ideal DCG is 0).
* **Baseline** = NDCG of the order actually served. The model must beat it.

---

## 9. Current model

| | |
|---|---|
| Version | `20261023-180920` (last updated 23 Oct 2026) |
| Training window | 23 Sep 2026 → 23 Oct 2026 |
| Data | 1206 lists (617 with an outcome), 12816 rows |
| Split | 964 train / 242 validation |
| Validation NDCG@10 | **0.6984** (model) vs **0.5688** (served order) → +23% |
| Trees kept | 13 (best iteration 12 of max 400) |
| Settings | `learning_rate` 0.05, `max_depth` 6 |
| XGBoost | 3.2.0 |

Early stopping kept only 13 trees: validation NDCG peaked early and more trees
would have overfit. That's expected with a small dataset; as more real outcomes
are collected, the model can use more trees.

**Compared with the previous run** (`20261023-174226`: 800 lists, NDCG 0.6083
vs 0.5062, 17 trees), this run trained on ~50% more lists and the model's
lead over the served order grew from +20% to +23%. Only about half the lists
now have an outcome (previously 93%), so the labels are sparser.

---

## 10. Prediction

```
margin(x) = base_score + Σ leaf(tree, x)
split rule: go left if x[f] < threshold; missing → the tree's default branch
```

The margin has no absolute meaning, only its **order within a list**. It is
min–max rescaled onto the list's rule-based score range and blended 50/50
with the rule-based score:

```
rescaled   = sMin + (m − mMin) / (mMax − mMin) × (sMax − sMin)
orderScore = 0.5 × score + 0.5 × rescaled
```

The top 60 candidates are re-sorted by `orderScore`.
