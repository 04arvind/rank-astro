# Ranking Pipeline — Layers, Metrics & Parameters

The ranking pipeline has 6 layers, run in order by `runRanking` in `lib/ranking/rank.ts`. Every value below comes from the code and `config/*.ts`.

## Overview

| # | Layer | What it does | Score it outputs | Main code | If it fails |
|---|---|---|---|---|---|
| 1 | Eligibility | Hard filters; failing astrologers are never scored | none | `lib/astrologer/eligibility.ts` | Request errors (required) |
| 2 | Business ranking | Weighted score from 9 composite scores, plus adjustments and extension terms | `totalScore` | `score.ts`, `scores.ts`, `extension.ts` | Request errors (required) |
| 3 | Candidate generation | Retrieval cap, then diversity and guardrail reordering; the top 60 become the ML shortlist | `totalScore` with diversity | `exploration/diversity.ts` | Request errors (required) |
| 4 | ML ranking | XGBoost LambdaMART reorders the shortlist | `orderScore` | `ml/rerank.ts`, `ml/model.ts` | Keeps the Layer-3 order |
| 5 | Exploration | Exploration slots, then premium slots 1–2, then Thompson sampling for slots 3–4 | `orderScore` | `explorationScore.ts`, `premiumSlots.ts`, `bandit/rerank.ts` | Keeps the order from before the bandit step |
| 6 | Final re-rank | Re-checks eligibility, removes duplicates, repairs constraint breaks, renumbers | `orderScore` | `final/rerank.ts` | Serves the Layer-5 order |

---

## Layer 1 — Eligibility (`config/eligibility.config.ts`)

| Rule | Parameter | Value | Exclusion reason |
|---|---|---|---|
| Provider enabled | `providers[].enabled` | A, B, C all `true` | `provider_disabled` |
| Request provider filter | `filters.providerIds` | from the request | `provider_filtered` |
| Verified profile | `profile.requireVerified` | `true` | `not_verified` |
| Avatar required | `profile.requireAvatar` | `false` | `no_avatar` |
| Minimum languages | `profile.minLanguages` | 1 | `too_few_languages` |
| Minimum categories + specializations | `profile.minCategories` | 1 | `too_few_categories` |
| Price per minute | `price.perMinute` | ₹5 – ₹500 | `price_out_of_range` |
| Request price range | `context.priceRange` | from the request | `price_filter` |
| Online only | `filters.onlineOnly` | from the request | `not_online` |
| Include offline astrologers | `availability.includeOffline` | `true` | `inactive` |
| Recently active window | `availability.recentlyActiveHours` | 72h (only used if offline astrologers are excluded) | `inactive` |
| Minimum rating | `quality.minRating` | 3.0 (only checked once there are at least 5 reviews) | `low_rating` |
| Minimum reviews before judging | `quality.minReviews` | 5 | — |
| Maximum complaint rate | `quality.maxComplaintRate` | 0.15 | `high_complaint_rate` |
| New-astrologer grace period | `newAstrologerGraceDays` | 30 days (quality floors skipped) | — |
| Missing-data policy | `missingData` | `"pass"` | — |

---

## Layer 2 — Business ranking

### Formula
```
baseScore  = Σ scoreWeights[segment][s] × s            (each s is 0..1)
finalScore = baseScore + providerBooster + quotaUrgencyBoost − frequencyPenalty
totalScore = finalScore + 0.04·conversion + 0.03·retention + 0.02·quotaUrgency
             − 0.05·lowQuality − 0.03·unavailable − 0.02·overExposure
```
A user is in the "returning" segment after at least 1 call in the last 180 days. A score with no data uses the neutral value 0.5.

### 2a. Composite score weights by segment (`scoreWeights`)

| Score | New user | Returning user | Business pillar |
|---|---|---|---|
| qualityScore | **0.26** | 0.20 | quality |
| personalizationScore | 0.04 | **0.22** | personalization |
| businessScore | 0.12 | 0.10 | profit / booking probability |
| priceScore | 0.06 | 0.08 | personalization |
| categoryScore | 0.14 | 0.10 | personalization |
| availabilityScore | 0.12 | 0.10 | availability |
| explorationScore | 0.06 | 0.03 | exposure fairness |
| languageScore | 0.14 | 0.10 | personalization |
| diversityScore | 0.06 | 0.07 | exposure fairness (set in Layer 3) |
| **Sum** | 1.00 | 1.00 | |

### 2b. Components inside each composite score

| Composite | Component (weight) | Metric / formula | Parameters |
|---|---|---|---|
| **qualityScore** | rating (0.35) | Bayesian average of provider and observed ratings ÷ 5 | priorMean 4.0, priorWeight 20, scaleMax 5 |
| | reviewConfidence (0.15) | reviews ÷ (reviews + 50) | halfAtReviews 50 |
| | experience (0.15) | log-saturated years of experience | saturationYears 15 |
| | completionRate (0.10) | avgCallMinutes ÷ 15 | targetCallMinutes 15 |
| | acceptanceRate (0.10) | responseRate (share of call attempts taken) | — |
| | complaintFree (0.10) | 1 − complaintRate | — |
| | repeatRate (0.05) | share of completed calls from returning callers | — |
| **personalizationScore** | repeatAstrologer (0.45) | max(min(calls÷5, 1) × half-life recency, 0.8 if favourite) | saturationCalls 5, halfLife 30d, favoriteValue 0.8 |
| | categoryAffinity (0.25) | best overlap with the categories of astrologers the user has consulted | — |
| | languageAffinity (0.15) | share of the user's calls in this astrologer's languages | — |
| | providerAffinity (0.15) | share of the user's calls to this provider | — |
| **businessScore** | expectedRevenue (0.35) | P(call) × price × minutes ÷ (1500 × 0.08) | defaultCallMinutes 8, ceiling 1500 |
| | contributionMargin (0.25) | margin scaled between min and target margin | minMarginRate 0.10, targetMarginRate 0.40 |
| | conversion (0.25) | (calls + 0.08·200) ÷ (impressions + 200), with the prior mapped to 0.5 | priorRate 0.08, priorStrength 200 |
| | expectedDuration (0.15) | minutes ÷ 16 | referenceCallMinutes 16 |
| **categoryScore** | categoryMatch (0.7) | primary 1 / secondary 0.6 / none 0 | — |
| | specializationMatch (0.3) | same scale | — |
| **availabilityScore** | availabilityStatus (0.6) | online 1, busy 0.4, offline 0, unknown 0.5 | — |
| | callReady (0.2) | 1 if online, otherwise 0 | — |
| | providerCapacity (0.2) | 1 − provider utilization | — |
| **priceScore** | priceAffinity (1.0) | full score within ±30% of the preferred price, then exponential decay | tolerance 0.3 |
| **languageScore** | languageMatch (1.0) | exact 1 / partial 0.5 / none 0 | — |
| **explorationScore** | exploration (1.0) | max(new-astrologer boost × (1 − impressions÷1000), 0.5·√(ln N ÷ (n+1))) | maxImpressions 1000, UCB coefficient 0.5, minImpressions 50 |

### 2c. Adjustments (`ranking.adjustments`)

| Adjustment | Formula | Key parameters |
|---|---|---|
| **providerBooster** (+) | min(visibilityGap ÷ 0.2, 1) × spareCapacity × 0.08 × efficiencyFactor | range 0 – 0.08, saturationGap 0.2, gates: quality ≥ 0.5 and relevance ≥ 0.5, capped at 20% of baseScore, performance minFactor 0.5 |
| providerBooster dampener (−) | −pressure × 0.05, where pressure = max(over target share, utilization above 0.75) | max 0.05, utilizationFrom 0.75, favourites and previous astrologers exempt |
| **quotaUrgencyBoost** (+) | max(provider deficit, astrologer deficit) × elapsed^1.5 × 0.05 | max 0.05, period 24h (IST), needs 50 impressions in the period, capped at 15% of baseScore, gates 0.5 / 0.5 |
| **frequencyPenalty** (−) | (viewer impressions − 3) × 0.02 + (global share multiple − 2) × 0.02 | 24h window, 3 free impressions, needs 100 window impressions, max 0.1, favourites and previous astrologers exempt |

### 2d. Extension terms (`ranking.extension`)

| Term | Kind | Weight | Formula / parameters |
|---|---|---|---|
| conversionScore | signal | 0.04 | click → completed-call rate, prior 0.15, prior strength 20 clicks |
| retentionScore | signal | 0.03 | repeat-caller rate, prior 0.20, prior strength 10 calls |
| quotaUrgencyScore | signal | 0.02 | provider or astrologer quota deficit, gated, needs 50 period impressions |
| lowQualityPenalty | penalty | 0.05 | (0.45 − quality) ÷ 0.45 when qualityScore < 0.45 |
| unavailablePenalty | penalty | 0.03 | online 0, busy 0.2, offline 1, unknown 0 |
| overExposurePenalty | penalty | 0.02 | impression share from 2× fair share (penalty 0) to 5× (penalty 1); needs 200 impressions; personal picks exempt |

---

## Layer 3 — Candidate generation (diversity + guardrails)

| Rule | Parameter | Value |
|---|---|---|
| Retrieval cap | `pagination.maxCandidates` | 500 |
| Diversity score | 1 ÷ (1 + same provider + same category already in the window) | — |
| Diversity window | `diversity.windowSize` | top 10 |
| Max same provider in a row | `maxConsecutiveSameProvider` | 2 |
| Max per provider in the window | `maxPerProviderInWindow` | 5 |
| Max per category in the window | `maxPerCategoryInWindow` | 6 |
| Top-N for guardrails | `business.guardrails.topN` | 10 |
| Max premium share in the top N | `maxPremiumShareTopN` | 0.3 (3 of 10) |
| Provider share cap in the top N | `share.max` | A 0.6, B 0.55, C 0.45 |
| Provider floor in the top N | `share.min` | A 0.2, B 0.15, C 0.1 |
| Floor: max score gap to the best remaining | `providerFloor.maxScoreGap` | 0.15 |
| Floor: excluded statuses | `excludeStatuses` | offline |
| ML shortlist size | `ml.shortlistSize` | 60 |

**Provider targets** (`provider.config.ts`)

| Provider | Target share | Min / Max share | Revenue share | Capacity |
|---|---|---|---|---|
| A — Astropatri | 0.40 | 0.20 / 0.60 | 0.35 | 200 |
| B — Talk to Guruji | 0.35 | 0.15 / 0.55 | 0.30 | 150 |
| C — Provider C | 0.25 | 0.10 / 0.45 | 0.40 | 80 |

Utilization settings: 60-minute window, saturation at 0.85, smoothing 0.3, live minimum supply 3.

---

## Layer 4 — ML ranking (XGBoost LambdaMART)

| Item | Value |
|---|---|
| Model | `XGBRanker`, objective `rank:ndcg`, `tree_method=hist`, top-k pair method |
| Training hyperparameters | n_estimators 400, learning rate 0.05, max_depth 6, subsample 0.8, colsample 0.8, λ 1.0, early stopping after 40 rounds, seed 42 |
| Training labels | 3 = completed consultation, 2 = booked, 1 = clicked, 0 = shown |
| Validation | newest 20% of lists held out; NDCG@10 must beat the order that was actually served |
| Blend | `orderScore = 0.5 × score + 0.5 × model margin rescaled to the score range` |
| Gates checked at load | ≥ 200 training lists, ≥ 30 lists with an outcome, lift over the served order required, model ≤ 45 days old |
| Other settings | cache 60s; training log: 50 items per request, kept 90 days; turn off with `RANKER_MODE=off` |
| **Features (47)** | 37 raw features plus 9 composite scores (`s_*`) plus `l2_totalScore`. Served position is deliberately not a feature, so the model can't learn position bias. |

Raw feature groups:

| Group | Features |
|---|---|
| Profile | rating, reviewCount, experienceYears, pricePerMinute, priceBand, payoutPerMinute, marginRate, minCallMinutes, consultationModeCount, specializationCount, verified |
| Availability | isOnline, isBusy, hoursSinceActive |
| Request fit | languageOverlap, categoryMatch |
| Lifecycle | ageDays, isNew |
| Observed performance | impressions, clicks, completedCalls, ctr, clickToCallRate, conversionRate, responseRate, repeatRate, avgCallMinutes, observedRating, observedRatingCount, complaintRate, revenuePerImpression |
| User history | userIsReturning, isFavorite, userCallsWithAstrologer, daysSinceUserLastCall, userTypicalPricePerMinute, priceDeltaRatio |

---

## Layer 5 — Exploration, premium slots, Thompson sampling

**5a. Exploration slots** (`exploration.config.ts`)

| Parameter | Value |
|---|---|
| Slot share | 10% of visible positions |
| Slot positions | 4 – 20, spread evenly |
| Who qualifies | new astrologer (≤ 30 days old) with < 1000 impressions, or anyone with < 50 impressions |
| Pick priority | score × (0.5 + seeded random) × (1 + 0.5 × provider gap), seeded per session |
| Still enforced | top-N premium cap and max 2 in a row from the same provider |

**5b. Premium slots**: positions 1–2 go to the best-ranked premium astrologers (price above ₹60/min) that pass the quality and relevance gates and aren't offline. If too few qualify, the top-ranked others fill the slots.

**5c. Thompson sampling** (`ranking.bandit`)

| Parameter | Value |
|---|---|
| Mode / policy version | `live` / `ts-1` (turn off with `BANDIT_MODE=off`) |
| Slots it controls | positions 3–4 |
| Candidate pool | top 60 |
| Reward | P(completed consultation \| shown), sampled from a Beta posterior |
| Objective blend | completion 0.5, profit 0.5 (sample × expected margin) |
| Prior | rate 0.02; strength: provider 500, astrologer 100, category context 20 |
| Effect of the Layer-2 score on the prior | provider rate × (score ÷ pool median)^2 |
| Fairness lift | 1 + 0.1 × provider gap |
| Gates | quality ≥ 0.5, relevance ≥ 0.5, not offline; personal picks stay in place (`pinPersonal`) |
| Holdout | 10% of viewers get the order from before the bandit step |
| Attribution and logging | exposure dedup 24h, attribution 72h, position decay 5, samples stable for 300s, cache 30s, reconcile every 60s with a 6h lookback, kept 120 days |

---

## Layer 6 — Final re-rank (`ranking.finalRerank`)

| Step | Setting | What it does |
|---|---|---|
| 1. Revalidate | `revalidate: true` | Runs the Layer-1 eligibility check again on the profile being served |
| 2. Dedupe | `dedupe: true` | Keeps the first (best) entry for each astrologer |
| 3. Safe order | — | Moves candidates with a non-finite score to the end |
| 4. Constraint repair | `enforceConstraints: true` | Top-10 provider share cap, top-10 premium cap (3), max 2 in a row from the same provider. Fixes a break by moving up the next candidate that fits; if none fits, the rule is relaxed and logged. |
| Exemptions | `exemptPersonal: true` | Favourites and previous astrologers, and premium and Thompson slot holders, are never moved |
| 5. Renumber | — | Ranks become 1..n |

---

## Settings that apply to every layer

| Parameter | Value |
|---|---|
| Metrics window | 30 days |
| Stable list cache per visitor | 300s |
| Neutral value when data is missing | 0.5 |
| Page size | default 20, max 100 |
| User-facing explanation | max 3 reasons; minimum contribution 0.01; minimum signal value 0.6; repeatAstrologer and categoryMatch reasons are shown first |
