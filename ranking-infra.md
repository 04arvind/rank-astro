### Ranking System :

How astrologers are ranked for User-Choice lists (`/api/astrologer/rank`, the home feed and the admin dashboard): six layers, each with its code, config, fallback and dashboard view. A "What changed" section and the operations runbook follow.

---

## 1. Overview

```
request ──► load pool ─► live availability ─► metrics / exposure / user signals ─► personalised context
        │
        ├─ L1  Eligibility           hard filters                       lib/astrologer/eligibility.ts
        ├─ L2  Business ranking      weighted business score            lib/ranking/score.ts, business/pillars.ts
        ├─ L3  Candidate generation  retrieval cap + diversity/guardrails, ML shortlist
        │                                                               lib/astrologer/condidate.ts, exploration/diversity.ts
        ├─ L4  ML ranking            XGBoost LambdaMART (rank:ndcg)     lib/ranking/ml/
        ├─ L5  Exploration           exploration slots + contextual Thompson sampling
        │                                                               exploration/explorationScore.ts, bandit/
        └─ L6  Final re-ranking      revalidate, dedupe, constraints, renumber
                                                                        lib/ranking/final/rerank.ts
        ▼
     served list  ──after()──► impressions · bandit exposures · ML training log
```

`runRanking()` in `lib/ranking/rank.ts` runs the pipeline. It is called by the ranking engine (`lib/ranking/index.ts` → `getRankingEngine()`), by the home feed (`lib/feed`) and by the scripts.

**Failure policy**

| Stage | On failure |
|---|---|
| Load, L1, features, L2, L3, exploration slots | Request fails with `RankingError(stage)` → HTTP 500 `RANKING_FAILED` (unchanged behaviour). |
| Live availability, metrics, user signals, provider state, bandit state | Logged; neutral fallback (unchanged). |
| **L4 ML** | Logged; the **Layer-3 order** passes through. |
| **L5 Thompson sampling** | Logged; the **pre-bandit order** passes through. |
| **L6 Final** | Logged; the **Layer-5 order** is served. |

Without a trained model (the current state), L4 is a no-op, and the served ranking matches the ranking before these changes, apart from the two small L5/L6 behaviour changes listed in §8.

---

## 2. The six layers

### Layer 1 — Eligibility
- **Code:** `checkEligibility()` in `lib/astrologer/eligibility.ts`, applied by `generateCandidates()` in `lib/astrologer/condidate.ts`.
- **Rules (config `eligibility`):**
  - provider enabled, and provider filter;
  - verified profile, avatar, minimum languages and categories;
  - price bounds and the request's price filter;
  - online-only filter, inactive-offline;
  - rating and complaint-rate floors, skipped during the new-astrologer grace period.
- **Output:** the eligible set, plus `excluded[]` with every failed reason (not just the first).
- **Status:** audited, unchanged.

### Layer 2 — Business ranking
- **Code:** `createWeightedScorer()` in `lib/ranking/score.ts`, which uses the signals in `lib/ranking/{astrologer,business,user,provider,exploration}/`.
- **Formula:**
  ```
  baseScore  = Σ scoreWeights[segment][s] × s        (quality, personalization, business, price,
                                                       category, availability, exploration, language, diversity)
  finalScore = baseScore + providerBooster + quotaUrgencyBoost − frequencyPenalty
  totalScore = finalScore + conversion + retention + quotaUrgency − lowQuality − unavailable − overExposure
  ```
- **New: business pillars** (`lib/ranking/business/pillars.ts`). Every score, component, adjustment and extension term is mapped onto the business factor it serves, and stored as `explanation.pillars`. Contributions **sum exactly to `totalScore`**; a test checks this.

  | Pillar | Fed by |
  |---|---|
  | bookingProbability | conversion, expectedDuration, conversionScore, retentionScore |
  | profit | expectedRevenue, contributionMargin |
  | quality | qualityScore, lowQualityPenalty |
  | personalization | personalizationScore, priceScore, categoryScore, languageScore |
  | availability | availabilityScore, unavailablePenalty |
  | utilization | providerCapacity, providerBooster (boost and dampener) |
  | exposureFairness | explorationScore, diversityScore, quotaUrgencyBoost/Score, frequencyPenalty, overExposurePenalty |
  | model | a blended model scorer's share (0 by default) |

  No weights were changed. The existing scorer already used all seven business factors; the pillars make them visible.

### Layer 3 — Candidate generation
- **Retrieval cap:** `generateCandidates()` keeps the top `ranking.pagination.maxCandidates` (500), with request-matching astrologers first. `CandidateSet.truncatedIds` (new, optional) lists the ones that were cut, so the dashboard can show them.
- **Diversity and guardrails:** `diversify()` in `lib/ranking/exploration/diversity.ts`:
  - max consecutive astrologers from one provider;
  - per-provider and per-category caps in the window;
  - top-N provider share max and premium cap;
  - provider floors.
- **Shortlist:** the top `ranking.ml.shortlistSize` (60) of this list goes to L4.
- **Status:** preserved; `truncatedIds` and tracing added.

### Layer 4 — ML ranking (new)
- **Model:** XGBoost LambdaMART (`XGBRanker`, `objective="rank:ndcg"`), trained offline in Python.
- **Inference:** done in TypeScript (`lib/ranking/ml/xgboost.ts`), which evaluates XGBoost's JSON model format directly. The server needs no Python and no native dependency.
  - Supports gbtree, numerical splits, missing values (default branch), float32 thresholds and `best_iteration`.
  - Rejects anything it can't evaluate faithfully: dart/gblinear boosters, categorical splits, multi-class models, malformed trees.
- **Features:** `lib/ranking/ml/features.ts`. `ML_FEATURE_NAMES` is the full feature vector (`FEATURE_NAMES`), plus the nine Layer-2 composite scores (`s_*`) and `l2_totalScore`.
  - Served position is deliberately **not** a feature, so the model can't learn position bias.
  - Models are matched to rows **by name**, so adding a feature doesn't break an older model.
- **Blend** (`lib/ranking/ml/rerank.ts`):
  ```
  rescaled   = sMin + (m − mMin)/(mMax − mMin) × (sMax − sMin)     // model margin → shortlist's score range
  orderScore = (1 − blendWeight) × score + blendWeight × rescaled   // blendWeight = 0.5
  ```
  The shortlist is re-sorted by `orderScore`; positions below the shortlist keep the L3 order. `orderScore` is in score units, so Thompson sampling can centre its prior on it.
- **Gates** (`lib/ranking/ml/model.ts`, config `ranking.ml.gates`). A model is used only if all of these hold:
  - it was trained on ≥ 200 served lists (`minTrainingQueries`);
  - ≥ 30 of those lists had an outcome (`minPositiveQueries`);
  - its validation NDCG@10 **beats the served (production) order** on the same held-out lists (`requireLiftOverBaseline`);
  - it is ≤ 45 days old (`maxModelAgeDays`);
  - it only uses features the app produces, with a `rank:*` objective.
- **Modes:** `RANKER_MODE` env (`off` | `shadow` | `live`) overrides config (`ml.enabled` → live).
  - `shadow` scores and records model output without re-ordering.
- **Fallback states**, shown on the dashboard with a reason:
  - `disabled`: switched off by config or `RANKER_MODE`;
  - `unavailable`: no model file;
  - `gated`: a model exists but fails a gate;
  - `error`: corrupt file, invalid booster, or non-finite scores at request time.
- **Loading:** the model is cached per process for `ml.cacheSeconds` (60) and re-read when the file's mtime or size changes. Gated or failed loads are logged once per load, not per request.

### Layer 5 — Exploration (contextual Thompson sampling)
- **Exploration slots:** `placeExploration()`. About 10% of positions 4–20 go to new or under-exposed astrologers, prioritised by the provider's gap below target. Unchanged.
- **Thompson sampling:** `thompsonRerank()` in `lib/ranking/bandit/rerank.ts`. Existing, extended:
  - **Contextual:** hierarchical Beta posteriors per category context → astrologer overall → provider prior (`bandit/posterior.ts`).
  - **Objective:** a blend of P(completed consultation) and expected margin (`bandit.objective`).
  - **New: fair exposure.**
    ```
    reward × (1 + fairness.weight × clamp(gap / providerBooster.saturationGap))
    ```
    This applies to competitors whose provider is below its target share; `bandit.fairness.weight` = 0.1, so the reward rises by up to 10%. It is stored as `decision.fairness`.
  - **New: ML-aware prior.** The prior's Layer-2 multiplier uses `orderScore ?? score`, so a live L4 model influences which astrologers the bandit favours before it has data.
  - Existing guards are kept:
    - provider share cap in the top N;
    - consecutive-same-provider rule;
    - favourites and previous astrologers pinned;
    - shadow mode, and the 10% holdout;
    - seeded, stable samples per viewer;
    - idempotent learning from completed consultations.

### Layer 6 — Final re-ranking (new)
- **Code:** `finalRerank()` in `lib/ranking/final/rerank.ts`. It only removes or repairs, so a valid list comes out unchanged.
- **Steps:**
  1. **Revalidate:** `checkEligibility()` again (including availability and online-only) on the profile being served.
  2. **Dedupe:** one entry per astrologer id; the best position is kept.
  3. **Safe order:** a non-finite score is moved to the end.
  4. **Constraints:** fixes violations of the top-N provider share cap, the top-N premium cap and the max-consecutive-same-provider rule. When the next candidate would break a rule, the first later candidate that doesn't is moved up (stable, greedy). If there is no alternative, the rule is relaxed and reported. The user's favourites and previous astrologers are never moved down (`exemptPersonal`).
  5. **Renumber:** ranks become 1..n.
- **Config:** `ranking.finalRerank { revalidate, dedupe, enforceConstraints, exemptPersonal }`.

---

## 3. Pipeline trace and admin dashboard

### Trace
`runRanking(ctx, { trace: true })` records the list after every layer (`lib/ranking/pipeline.ts`, `PipelineRecorder`). It is used only by `engine.debug()`; the production `rank()` path doesn't trace.

```ts
PipelineTrace { layers: PipelineLayer[]; totalMs; generatedAt }
PipelineLayer {
  layer: 1..6; key: "eligibility"|"business"|"candidates"|"ml"|"exploration"|"final";
  title; description; status: "applied"|"passthrough"|"fallback"; note?;
  durationMs; inputCount; outputCount; scoreLabel;
  entries:  { astrologerId, providerId, rank, score }[];
  filtered: { astrologerId, providerId, reasons[] }[];       // removed at this layer, with why
  details?: Record<string, string|number|boolean|null>;
}
```

Set `RANKING_TRACE_LOG=1` to log one summary line per traced run:

```
[ranking] pipeline 12.3ms L1:applied(40→34) L2:applied(34→34) …
```

### Dashboard (`/admin` → "Ranking pipeline — step by step")
- **Component:** `components/admin/RankingPipeline.tsx`, a client component. `app/admin/page.tsx` slims each candidate server-side, so only display fields reach the browser.
- **Layer stepper:** six cards showing status, input → output counts, number removed, timing and fallback notes. Click a card to inspect that layer.
- **Compare layers:** pick any two layers (default: the previous layer → the selected one).
  - Each row shows the rank, astrologer, provider, price, the score at that layer, the previous rank, and the change (▲ / ▼ / new).
  - Click a row for its breakdown:
    - L2 business pillars, as a stacked bar plus per-pillar contributions;
    - L4 model score → rescaled → orderScore;
    - L5 θ sample, posterior mean, reward, fairness multiplier, exposures and completions;
    - every re-rank note explaining why it moved.
- **Rank journey:** a matrix of the final list × each layer's rank, with per-layer movement and the net change from L2.
- **Filtered:** for each layer, who was removed and why: L1 eligibility reasons, the L3 retrieval cap, L6 duplicates and failed revalidation. Reasons are grouped with counts.
- **Provider exposure:** each provider's share of the top 10 after every layer (L1: share of eligible supply), against the target tick and the configured min–max. Shares outside the range are shown in red.
- **Label update:** the existing panels were relabelled to the new numbering ("Layer 5 — Thompson sampling", "pre-bandit" instead of "Layer 2").

### API
| Route | Change |
|---|---|
| `POST /api/admin/ranking/pipeline` | **New.** Same body as `/debug`. Returns `{ pipeline, candidates }`. |
| `POST /api/admin/ranking/debug` | Response unchanged. Candidates gain optional `layers`, `ml` and `thompson.fairness` fields. |
| `GET/POST /api/astrologer/rank`, `GET /api/astrologer/feed` | Response unchanged. Each now also logs a training sample in `after()`. |

---

## 4. ML training workflow

```
served list ──► ranking_training_samples (feature rows as served)
                         │
npm run ml:export  ──────┤ join clicks + bookings → graded labels
                         ▼
        data/ml/training.jsonl + training.meta.json
                         │
npm run ml:train   ──────┤ XGBRanker(rank:ndcg), time-based split, lift check
                         ▼
        data/models/ranker.json   ──► picked up by the app within ml.cacheSeconds
```

**Training log** (`lib/ranking/ml/trainingLog.ts`)
- **Contents:** one sample per served list (request id, time, surface, user/session, category, segment, `featureVersion`), plus each item's position and feature row at serving time, so there is no leakage from later data.
- **Skipped:** anonymous viewers and lists with fewer than two items. At most 50 items per list are kept.
- **Storage:** `InMemoryTrainingLogStore` by default; `MongoTrainingLogStore` (`db/trainingStore.ts`), installed by `installDatabase()` when Mongo is configured.
  - Collection `ranking_training_samples`, `_id = requestId`, TTL `ml.trainingLog.retentionDays` (90).
  - A **new collection**; no existing collection or document shape changed.
- **Labels** (`buildTrainingSet()`):

  | Label | Meaning |
  |---|---|
  | 3 | Completed User-Choice consultation (call connected and ended) |
  | 2 | Booked |
  | 1 | Clicked in that list (analytics click with the same `requestId`), or the booking was cancelled |
  | 0 | Shown only |

  Each booking credits the viewer's **latest** list that showed that astrologer within `bandit.attributionHours` (72h) before the booking. First-Out (duration-card) bookings are ignored. Samples whose `featureVersion` doesn't match the current feature layout are skipped.

**Trainer** (`scripts/ml/train_ranker.py`; dependencies in `scripts/ml/requirements.txt`)
- **Data handling:** groups rows by list, orders them by time, and holds out the newest 20% for validation.
- **Model:** `XGBRanker(objective="rank:ndcg", lambdarank_pair_method="topk", eval_metric="ndcg@10")`, with early stopping. Only the best-iteration trees are kept.
- **Validation:** compares the model's NDCG@10 with the **served order's** NDCG@10 on the same held-out lists.
- **Output:** writes the artifact atomically. Exit codes:
  - `0`: written;
  - `3`: not enough data;
  - `4`: no lift (override with `--force`; the app still applies its own gates).
- **Artifact format:** `rank-astro/xgb-ranker@1`:
  ```json
  { "format": "...", "name", "version", "objective": "rank:ndcg", "trainedAt", "featureNames": [...],
    "training": { "queries", "positiveQueries", "rows", ... },
    "validation": { "metric": "ndcg@10", "model", "baseline", "queries" },
    "params": {...}, "booster": { /* XGBoost save_raw("json") */ } }
  ```

**Golden check:** `scripts/ml/golden_fixture.py` trains a small `XGBRanker` and writes `test/fixtures/ml/xgb-golden.json`, which holds XGBoost's own margins. The test suite then checks that the TypeScript evaluator reproduces them. Re-run it after upgrading XGBoost.

---

## 5. Configuration (`config/ranking.config.ts`, validated in `config/schema.ts`)

```ts
bandit: { …, fairness: { weight: 0.1 } },             // L5 fair-exposure lift (0 = off)

ml: {                                                 // L4
  enabled: true,
  modelPath: "data/models/ranker.json",               // RANKER_MODEL_PATH overrides
  shortlistSize: 60,
  blendWeight: 0.5,                                   // 0 = business score only, 1 = model only
  gates: { minTrainingQueries: 200, minPositiveQueries: 30, requireLiftOverBaseline: true, maxModelAgeDays: 45 },
  cacheSeconds: 60,
  trainingLog: { enabled: true, maxItemsPerRequest: 50, retentionDays: 90 },
},

finalRerank: { revalidate: true, dedupe: true, enforceConstraints: true, exemptPersonal: true },   // L6
```

| Env var | Effect |
|---|---|
| `RANKER_MODE=off\|shadow\|live` | L4 kill switch, or shadow mode. |
| `RANKER_MODEL_PATH` | Alternative model file. |
| `BANDIT_MODE=off\|shadow\|live` | L5 Thompson kill switch (existing; precedence env > admin flag > config). |
| `RANKING_TRACE_LOG=1` | One log line per traced (debug) run. |

---

## 6. Operations runbook

**First model**
1. Let traffic accumulate training samples (needs MongoDB).
2. `pip install -r scripts/ml/requirements.txt`
3. `npm run ml:export -- --days 30`
4. `npm run ml:train`. Exit 3 means not enough data yet; exit 4 means the model didn't beat the current ranking. In both cases nothing changes.
5. Optionally deploy with `RANKER_MODE=shadow` first, and compare L3 with the model output in the dashboard.
6. Switch to `live`. The dashboard's L4 card should show `applied` with the model name.

**Rollback**

| Layer | How |
|---|---|
| L4 | `RANKER_MODE=off`, or delete or rename `data/models/ranker.json`. Takes effect within `ml.cacheSeconds`. |
| L5 | `BANDIT_MODE=off`, or the admin flag. Fairness alone: `bandit.fairness.weight: 0`. |
| L6 | `finalRerank.enforceConstraints: false` (revalidation and dedupe can be disabled the same way). |

**Monitoring**
- **Dashboard:** layer status cards show any fallback and its reason; the provider exposure tab shows shares against targets; the existing bandit panel shows treatment-vs-holdout lift.
- **Logs:** look for `RANKING_FAILED` entries with stage `ml` / `bandit` / `final`, and `[ranking] learned ranker loaded: …`.

---

## 7. Tests

`npm test` runs `test/bandit/*.test.ts` (existing) and `test/pipeline/*.test.ts` (new): **45 tests; 42 pass, 3 skip, 0 fail.**

| File | Covers |
|---|---|
| `test/pipeline/pipeline.test.ts` | Six layers traced in order; L1 counts and reasons; L2 in score order; L6 = served list; with no model, L4 falls back and the order is unchanged; tracing doesn't change results; pillars sum to totalScore; `debug()` shape and per-layer ranks; `rank()` feature rows for the served page. |
| `test/pipeline/ml.test.ts` | Evaluator (splits, missing values, float32, multiple trees, base score, `best_iteration`, rejections); every gate; feature rows; live re-rank (shortlist only, orderScore); shadow; off; gated or broken model → L3 order; bandit runs with `orderScore`; golden XGBoost comparison (skipped until the fixture is generated). |
| `test/pipeline/final.test.ts` | Valid list unchanged; dedupe and renumber; drop on failed revalidation (offline under online-only); constraint repair; non-finite score last; fairness lift only for under-target providers. |
| `test/pipeline/training.test.ts` | Sample logging (anonymous / single-item skipped); labels 3/2/1/0; latest-list attribution; First-Out bookings ignored. |

**Skipped:** two existing Mongo tests (need `BANDIT_TEST_MONGO_URI`) and the golden XGBoost test (XGBoost couldn't be installed in the build environment because of network timeouts). The Python trainer hasn't been run end-to-end yet.

---

## 8. What changed (file list)

**New**
- `lib/ranking/pipeline.ts`: layer metadata and `PipelineRecorder`.
- `lib/ranking/business/pillars.ts`: L2 business pillars.
- `lib/ranking/ml/{features,xgboost,model,rerank,trainingLog,index}.ts`: L4.
- `lib/ranking/final/rerank.ts`: L6.
- `db/trainingStore.ts`: Mongo training log (new collection).
- `app/api/admin/ranking/pipeline/route.ts`: pipeline API.
- `components/admin/RankingPipeline.tsx`: dashboard view.
- `scripts/ml-export.ts`, `scripts/ml/train_ranker.py`, `scripts/ml/golden_fixture.py`, `scripts/ml/requirements.txt`.
- `test/pipeline/{helpers,pipeline,ml,final,training}.test.ts`.

**Modified (additive / minimal)**
- `lib/ranking/rank.ts`: explicit six layers, tracing, L4/L6 wired in. When ML is off, the same operations run in the same order.
- `lib/ranking/index.ts`: `debug()` returns `pipeline` and per-candidate `layers` / `ml`, and lists L6 drops. `rank()` returns server-only `trainingRows`, `category` and `segment`.
- `lib/ranking/score.ts`: `finalize()` attaches `pillars`.
- `lib/ranking/types.ts`: `orderScore?`, `ml?` and the `ml` / `final` re-rank stages.
- `lib/ranking/bandit/rerank.ts`, `bandit/policy.ts`: fairness multiplier, `orderScore`-aware prior, `decision.fairness`.
- `lib/astrologer/condidate.ts`: optional `truncatedIds`.
- `lib/errors.ts`: `RankingStage` gains `ml` and `final`.
- `types/ranking.ts`: `BusinessPillars`, pipeline types, optional `CandidateDebug` / `RankingDebugResult` fields.
- `config/ranking.config.ts`, `config/schema.ts`: `ml`, `finalRerank` and `bandit.fairness`.
- `app/api/astrologer/rank/route.ts`, `app/api/astrologer/feed/route.ts`: training sample logged in `after()`.
- `db/index.ts`: installs `MongoTrainingLogStore`.
- `app/admin/page.tsx`: pipeline panel.
- `components/admin/{BanditComparison,BanditPanel,ScoreBreakdownTable}.tsx`: labels only.
- `package.json`: `ml:export` and `ml:train` scripts; the test glob includes `test/pipeline`.
- `.gitignore`: `/data/ml/` (exports contain user ids).

**Behaviour changes with no model installed**
1. **L5 fairness:** Thompson rewards of under-target providers' qualified astrologers rise by up to 10%. Disable with `bandit.fairness.weight: 0`.
2. **L6 constraint repair:** can fix the rare provider-cap or same-provider-run breaks that exploration placement previously allowed. Disable with `finalRerank.enforceConstraints: false`.
3. **Training log:** served lists are now logged to `ranking_training_samples`.

**Unchanged:** API response shapes, booking/payment flows, existing collections and document shapes, user-facing UI.
