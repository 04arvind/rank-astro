import { z } from "zod";

/*
 * Shape + invariants for every tunable value. Types are inferred from these
 * schemas so the config files and their validation can never drift apart.
 * Only structural checks live here — no ranking maths.
 */

const unit = z.number().min(0).max(1); // 0..1 inclusive
const nonNeg = z.number().nonnegative();
const posInt = z.number().int().positive();

const range = (n: z.ZodNumber) =>
  z
    .object({ min: n, max: n })
    .refine((r) => r.min <= r.max, { message: "min must be <= max" });

/** Refinement: the numeric values of an object must add up to 1. */
const sumsToOne =
  (label: string) =>
  (values: Record<string, number>, ctx: z.RefinementCtx) => {
    const total = Object.values(values).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > 1e-6) {
      ctx.addIssue({ code: "custom", message: `${label} must sum to 1 (got ${total.toFixed(4)})` });
    }
  };

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const option = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "ids are lowercase kebab-case"),
  label: z.string().min(1),
  /** Provider spellings that map to this id (matched case-insensitively). */
  aliases: z.array(z.string().min(1)).default([]),
});

const optionList = z
  .array(option)
  .min(1)
  .superRefine((opts, ctx) => {
    const seen = new Map<string, string>();
    for (const o of opts) {
      for (const key of [o.id, o.label, ...o.aliases].map((s) => s.toLowerCase())) {
        const owner = seen.get(key);
        if (owner && owner !== o.id) {
          ctx.addIssue({ code: "custom", message: `"${key}" maps to both "${owner}" and "${o.id}"` });
        }
        seen.set(key, o.id);
      }
    }
  });

export const catalogSchema = z.object({
  /** Consultation topics users browse by (love, career…). */
  categories: optionList,
  /** Astrology disciplines an astrologer practises (vedic, tarot…). */
  specializations: optionList,
  languages: optionList,
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Normalized inputs ("components") that make up the composite scores. Each is
 * computed by one function in lib/ranking and returns 0..1 or null (unknown).
 */
export const SIGNALS = [
  // qualityScore
  "rating",
  "reviewConfidence",
  "experience",
  "completionRate",
  "acceptanceRate",
  "complaintFree",
  "repeatRate",
  // personalizationScore
  "repeatAstrologer",
  "categoryAffinity",
  "languageAffinity",
  "providerAffinity",
  // businessScore
  "expectedRevenue",
  "contributionMargin",
  "conversion",
  "expectedDuration",
  // priceScore
  "priceAffinity",
  // categoryScore
  "categoryMatch",
  "specializationMatch",
  // availabilityScore
  "availabilityStatus",
  "callReady",
  "providerCapacity",
  // explorationScore
  "exploration",
  // languageScore
  "languageMatch",
] as const;

export const signalSchema = z.enum(SIGNALS);

/** Composite scores combined into baseScore. */
export const SCORES = [
  "qualityScore",
  "personalizationScore",
  "businessScore",
  "priceScore",
  "categoryScore",
  "availabilityScore",
  "explorationScore",
  "languageScore",
  "diversityScore",
] as const;

export const scoreSchema = z.enum(SCORES);

const scoreWeights = (label: string) => z.record(scoreSchema, unit).superRefine(sumsToOne(`${label} score weights`));

/** Component weights inside one composite score; renormalized over known components at runtime. */
const componentWeights = <K extends string>(label: string, keys: readonly [K, ...K[]]) =>
  z.record(z.enum(keys), unit).superRefine(sumsToOne(`${label} component weights`));

/** Guards that keep provider optimization from overriding relevance or quality. */
const gates = z.object({
  /** Adjustment is withheld unless qualityScore is at least this. */
  minQualityScore: unit,
  /** …and relevance (the lower of language/category score, when requested) is at least this. */
  minRelevance: unit,
  /** Adjustment may not exceed this fraction of the candidate's baseScore. */
  maxRelativeToBase: nonNeg,
});

export const USER_SEGMENTS = ["newUser", "returningUser"] as const;

export const rankingSchema = z.object({
  engine: z.object({ name: z.string().min(1), version: z.string().min(1) }),

  /** Analytics window the performance components read from. */
  metricsWindow: z.enum(["1h", "24h", "7d", "30d"]),

  /**
   * Seconds a visitor's computed ranking (per filter set) is reused by the
   * engine, so the astrologers page, refreshes and the admin dashboard see
   * one order even though each served list records impressions and bandit
   * exposures that change the next computation. 0 recomputes every request.
   */
  stableListSeconds: z.number().int().nonnegative(),

  /**
   * Value a composite score takes when none of its components are known
   * (provider never supplied the data, or the request didn't ask) — neutral,
   * so missing data neither helps nor hurts.
   */
  neutralValue: unit,

  explanation: z.object({
    /** User-facing reasons shown per astrologer. */
    maxUserReasons: posInt,
    /** A component must contribute at least this much to be cited as a reason. */
    minContribution: nonNeg,
    /** …and score at least this high (0..1). */
    minSignalValue: unit,
    /** Reasons from these components are listed first, in this order, and skip minSignalValue. */
    priority: z.array(signalSchema),
  }),

  pagination: z
    .object({ defaultLimit: posInt, maxLimit: posInt, maxCandidates: posInt })
    .refine((p) => p.defaultLimit <= p.maxLimit, { message: "defaultLimit must be <= maxLimit" }),

  segmentation: z.object({
    /** Completed calls needed before a user is treated as returning. */
    returningUserMinCalls: z.number().int().nonnegative(),
    /** Look-back window for user history, in days. */
    historyWindowDays: posInt,
  }),

  /** baseScore = Σ scoreWeights[segment][score] × score; each profile sums to 1. */
  scoreWeights: z.object({
    newUser: scoreWeights("newUser"),
    returningUser: scoreWeights("returningUser"),
  }),

  /** How each composite score blends its components (each sums to 1). */
  components: z.object({
    qualityScore: componentWeights("quality", ["rating", "reviewConfidence", "experience", "completionRate", "acceptanceRate", "complaintFree", "repeatRate"]),
    personalizationScore: componentWeights("personalization", ["repeatAstrologer", "categoryAffinity", "languageAffinity", "providerAffinity"]),
    businessScore: componentWeights("business", ["expectedRevenue", "contributionMargin", "conversion", "expectedDuration"]),
    categoryScore: componentWeights("category", ["categoryMatch", "specializationMatch"]),
    availabilityScore: componentWeights("availability", ["availabilityStatus", "callReady", "providerCapacity"]),
  }),

  /** finalScore = baseScore + providerBooster + quotaUrgencyBoost − frequencyPenalty */
  adjustments: z.object({
    providerBooster: gates.extend({
      /** Bounds on the booster (min ≥ 0: it only ever lifts under-target providers). */
      min: z.number().min(0).max(1),
      max: z.number().min(0).max(1),
      /** Visibility gap (target − actual share) at which the booster saturates. */
      saturationGap: z.number().positive().max(1),
      /**
       * Scales the boost by provider conversion vs. platform (smoothed):
       * factor = clamp(efficiency, minFactor, 1), so balancing never pours
       * traffic into a provider that converts poorly.
       */
      performance: z.object({ enabled: z.boolean(), minFactor: unit }),
      /**
       * Bounded reduction for over-target or over-utilized providers:
       *   −max × max(over-target, over-utilization) × clamp(1/efficiency, minFactor, 1)
       * capped at maxRelativeToBase × baseScore.
       */
      dampener: z.object({
        enabled: z.boolean(),
        max: z.number().min(0).max(1),
        /** Over-target share (actual − target) at which the dampener saturates. */
        saturationGap: z.number().positive().max(1),
        /** Utilization above this starts dampening, reaching full at 1. */
        utilizationFrom: z.number().min(0).max(0.99),
        /** Never dampen the user's favourites or previously consulted astrologers. */
        exemptPersonal: z.boolean(),
      }),
    }).refine((b) => b.min <= b.max, { message: "providerBooster.min must be <= max" }),

    quotaUrgency: gates.extend({
      max: z.number().min(0).max(1),
      /** Quota period length, aligned to local midnight via timezoneOffsetMinutes. */
      periodHours: posInt,
      timezoneOffsetMinutes: z.number().int().min(-720).max(840),
      /** urgency = deficit × elapsed^exponent — higher = urgency builds later in the period. */
      timePressureExponent: z.number().positive(),
      /** Provider deficits are ignored until the period has this many top-N impressions. */
      minPeriodImpressions: z.number().int().nonnegative(),
      /** Optional per-astrologer minimum impressions per period (contracts, promotions). */
      astrologerQuotas: z.record(z.string(), posInt),
    }),

    frequencyPenalty: z.object({
      /** Look-back window for "shown recently". */
      windowHours: posInt,
      /** Impressions to the same user/session before fatigue starts. */
      freeUserImpressions: z.number().int().nonnegative(),
      perUserImpression: unit,
      /** Global part starts when an astrologer's share of recent impressions exceeds this multiple of a fair share. */
      globalOverexposureMultiple: z.number().positive(),
      perExcessShare: unit,
      /** Global part needs at least this many recent impressions overall. */
      minWindowImpressions: z.number().int().nonnegative(),
      max: unit,
      /** Don't fatigue the user's favourites or previously consulted astrologers. */
      exemptPersonal: z.boolean(),
    }),
  }),

  /**
   * Extra signals and penalties layered on the existing finalScore:
   *   totalScore = finalScore + Σ weights[s] × s − lowQuality − unavailable
   *              − w6 × overExposurePenalty
   * (providerBooster is already part of finalScore). Every term is 0..1
   * before its weight. Disabled → totalScore = finalScore.
   */
  extension: z.object({
    enabled: z.boolean(),
    /** Added on top of finalScore; not part of the sum-to-1 baseScore weights. */
    weights: z.object({
      conversionScore: nonNeg,
      retentionScore: nonNeg,
      quotaUrgencyScore: nonNeg,
    }),
    conversion: z.object({
      /** Click → completed-call rate assumed before data; maps to 0.5. */
      priorRate: z.number().positive().max(1),
      /** Pseudo-clicks given to the prior. */
      priorStrengthClicks: nonNeg,
    }),
    retention: z.object({
      /** Share of calls from returning callers assumed before data; maps to 0.5. */
      priorRate: z.number().positive().max(1),
      /** Pseudo-calls given to the prior. */
      priorStrengthCalls: nonNeg,
    }),
    quotaUrgency: z.object({
      /** Provider deficit is ignored until the period has this many top-N impressions. */
      minPeriodImpressions: z.number().int().nonnegative(),
    }),
    penalties: z.object({
      overExposure: z.object({
        /** w6 in totalScore; keep low. */
        weight: unit,
        /** Penalty starts when an astrologer's share of impressions exceeds this multiple of a fair share… */
        startMultiple: z.number().positive(),
        /** …and reaches 1 at this multiple. */
        fullMultiple: z.number().positive(),
        /** Needs at least this many impressions across candidates in the metrics window. */
        minImpressions: z.number().int().nonnegative(),
        /** Don't penalize the user's favourites or previously consulted astrologers. */
        exemptPersonal: z.boolean(),
      }).refine((o) => o.fullMultiple > o.startMultiple, { message: "overExposure.fullMultiple must be > startMultiple" }),
      lowQuality: z.object({
        weight: unit,
        /** Only qualityScore below this is penalized, scaled by how far below. */
        threshold: unit,
      }),
      unavailable: z.object({
        weight: unit,
        /** Penalty (0..1) per availability status; offline is usually better excluded by eligibility. */
        byStatus: z.object({ online: unit, busy: unit, offline: unit, unknown: unit }),
      }),
    }),
  }),

  /**
   * Layer 3 — Thompson sampling (lib/ranking/bandit) for User-Choice lists.
   * Runs after the Layer-2 ranking and never changes any score: it decides
   * who gets the top `slots` positions by sampling each qualified
   * candidate's posterior P(completed consultation | shown), whose prior is
   * centred on its Layer-2 score. Rarely-shown astrologers have wide
   * posteriors, so they win top slots now and then and get learned.
   * First-Out allocation never reads it.
   */
  bandit: z
    .object({
      /** "off": Layer 2 order, no logging. "shadow": sampled and learned, order unchanged. "live": re-ranks. BANDIT_MODE env and the admin flag override this. */
      mode: z.enum(["off", "shadow", "live"]),
      /** Bump to start learning from scratch (arms are keyed by it); old state stays for rollback. */
      policyVersion: z.string().regex(/^[a-z0-9.-]+$/),
      /** Thompson picks fill positions firstSlot..slots only (above: premium slots; below: the pre-bandit order). */
      firstSlot: posInt,
      /** Last position assigned by Thompson sampling; below it the pre-bandit order is kept. */
      slots: posInt,
      /** Candidates from Layer-2 positions 1..poolSize compete for those slots. */
      poolSize: posInt,
      /** Prior mean ∝ (Layer-2 score / pool median)^exponent: 0 ignores Layer 2, higher trusts it more until data arrives. */
      layer2PriorExponent: nonNeg,
      /** The user's favourites and previously consulted astrologers keep their Layer-2 position. */
      pinPersonal: z.boolean(),
      /** Share of viewers (hashed) kept on the Layer-2 order, to measure lift. */
      holdoutShare: unit,
      /** What a sample is ranked by: completion probability, expected margin, or a blend; must sum to 1. */
      objective: z.object({ completion: unit, profit: unit }).superRefine(sumsToOne("bandit.objective")),
      prior: z.object({
        /** Completed consultations per (examined) exposure assumed before data. */
        rate: z.number().positive().max(1),
        /** Pseudo-exposures behind the platform prior when estimating a provider's rate. */
        providerStrength: z.number().positive(),
        /** Pseudo-exposures the provider rate is worth inside an astrologer's prior. */
        astrologerStrength: z.number().positive(),
        /** Cap on pseudo-exposures the astrologer's overall posterior lends a per-context arm. */
        contextStrength: z.number().positive(),
      }),
      /** Exposure weight = 1 / (1 + (position − 1) / positionDecay): lower slots are seen less, so count less. */
      positionDecay: z.number().positive(),
      /** A viewer seeing the same astrologer again inside this window is one exposure. */
      exposureDedupHours: z.number().positive(),
      /** A booking created within this long after the viewer's last exposure is attributed to it. */
      attributionHours: z.number().positive(),
      /** Samples are re-drawn per viewer every this many seconds (stable lists on refresh). */
      sampleStableSeconds: z.number().int().positive(),
      /** Posterior cache lifetime per process. */
      cacheSeconds: z.number().int().nonnegative(),
      /** Only candidates passing these (and not offline) can be moved into a slot; others keep their position. */
      gates: z.object({ minQualityScore: unit, minRelevance: unit }),
      reconcile: z.object({
        /** Minimum seconds between on-demand outcome reconciliations per process. */
        intervalSeconds: z.number().int().positive(),
        /** Bookings that ended this long before the cursor are re-checked (idempotent). */
        lookbackHours: z.number().positive(),
        /** Lease so only one process reconciles at a time. */
        leaseSeconds: z.number().int().positive(),
      }),
      /** Raw recommendation events and exposures are kept this long (TTL). */
      retentionDays: z.number().int().positive(),
      /**
       * Fair provider exposure: reward × (1 + weight × clamp(gap / providerBooster.saturationGap))
       * for competitors of under-target providers (gap = target − actual share). 0 disables.
       */
      fairness: z.object({ weight: unit }),
    })
    .refine((b) => b.retentionDays * 24 > b.attributionHours, { message: "bandit.retentionDays must outlast attributionHours" })
    .refine((b) => b.poolSize >= b.slots, { message: "bandit.poolSize must be >= slots" })
    .refine((b) => b.firstSlot <= b.slots, { message: "bandit.firstSlot must be <= slots" }),

  /**
   * Reserved top positions 1..count for premium astrologers (business.priceBands
   * premium) that pass the provider quality/relevance gates and aren't offline,
   * best pre-bandit position first; if fewer qualify, the top-ranked others fill them.
   * Applied in Layer 5 before Thompson sampling, whatever the bandit mode.
   */
  premiumSlots: z.object({ enabled: z.boolean(), count: z.number().int().nonnegative() }),

  /**
   * Layer 4 — learned ranker (lib/ranking/ml): an XGBoost LambdaMART model
   * (XGBRanker, objective rank:ndcg) trained by scripts/ml/train_ranker.py
   * and evaluated in-process. It re-orders the Layer-3 shortlist only when a
   * model is loaded and passes `gates`; otherwise that order passes through.
   *   orderScore = (1 − blendWeight) × score + blendWeight × mlRescaled
   * where mlRescaled maps the model's margin onto the shortlist's score range.
   * RANKER_MODE=off (env) disables it at deploy time.
   */
  ml: z.object({
    enabled: z.boolean(),
    /** Model artifact, relative to the project root (RANKER_MODEL_PATH overrides). */
    modelPath: z.string().min(1),
    /** Layer-3 positions 1..shortlistSize are re-scored; the rest keep their order below. */
    shortlistSize: posInt,
    /** 0 = business score only, 1 = model only. */
    blendWeight: unit,
    /** A model is used only if its training metadata clears these. */
    gates: z.object({
      /** Request groups (served lists) it was trained on. */
      minTrainingQueries: posInt,
      /** …of which had at least one click or completed consultation. */
      minPositiveQueries: posInt,
      /** Validation NDCG must beat the served (production) order on the same data. */
      requireLiftOverBaseline: z.boolean(),
      maxModelAgeDays: posInt,
    }),
    /** How long a loaded model (or a load failure) is cached per process. */
    cacheSeconds: z.number().int().nonnegative(),
    /** Feature snapshots of served lists, joined with outcomes to build training data. */
    trainingLog: z.object({ enabled: z.boolean(), maxItemsPerRequest: posInt, retentionDays: posInt }),
  }),

  /** Layer 6 — final checks before serving (lib/ranking/final). */
  finalRerank: z.object({
    /** Re-run eligibility on every candidate (guards later layers from serving an ineligible profile). */
    revalidate: z.boolean(),
    /** One entry per astrologer id. */
    dedupe: z.boolean(),
    /** Repair violations of the top-N provider/premium caps and the consecutive-same-provider rule. */
    enforceConstraints: z.boolean(),
    /** The user's favourites and previously consulted astrologers are never moved down by the repair. */
    exemptPersonal: z.boolean(),
  }),

  /** Parameters consumed by individual component functions. */
  signals: z.object({
    rating: z.object({
      /** Bayesian prior: rating assumed before any reviews. */
      priorMean: z.number().min(0).max(5),
      /** Pseudo-review count given to the prior. */
      priorWeight: nonNeg,
      scaleMax: z.number().positive(),
    }),
    reviewConfidence: z.object({
      /** Review count at which confidence reaches 0.5. */
      halfAtReviews: z.number().positive(),
    }),
    experience: z.object({
      /** Years at which the experience component saturates. */
      saturationYears: z.number().positive(),
    }),
    completion: z.object({
      /** Average call length (minutes) treated as a fully completed consultation. */
      targetCallMinutes: z.number().positive(),
    }),
    availability: z.object({
      scores: z.object({ online: unit, busy: unit, offline: unit, unknown: unit }),
    }),
    categoryMatch: z.object({ primary: unit, secondary: unit, none: unit }),
    languageMatch: z.object({ exact: unit, partial: unit, none: unit }),
    priceAffinity: z.object({
      /** Allowed deviation from the preferred price before the score decays, as a fraction. */
      tolerance: unit,
    }),
    repeatAstrologer: z.object({
      /** Component value for a favourited astrologer (the higher of this and call history). */
      favoriteValue: unit,
      /** Half-life in days for past-interaction recency. */
      recencyHalfLifeDays: z.number().positive(),
      /** Calls with an astrologer after which the component saturates. */
      saturationCalls: posInt,
    }),
  }),
});

// ---------------------------------------------------------------------------
// Eligibility (hard filters, applied before scoring)
// ---------------------------------------------------------------------------

export const eligibilitySchema = z.object({
  quality: z.object({
    minRating: z.number().min(0).max(5),
    /** Reviews needed before the rating floor is enforced. */
    minReviews: z.number().int().nonnegative(),
    maxComplaintRate: unit,
  }),
  price: z.object({ perMinute: range(z.number().nonnegative()) }),
  availability: z.object({
    includeOffline: z.boolean(),
    /** Offline astrologers seen within this many hours stay eligible. */
    recentlyActiveHours: nonNeg,
  }),
  profile: z.object({
    requireVerified: z.boolean(),
    requireAvatar: z.boolean(),
    minLanguages: z.number().int().nonnegative(),
    minCategories: z.number().int().nonnegative(),
  }),
  /** New astrologers skip the rating/review floors for this long. */
  newAstrologerGraceDays: z.number().int().nonnegative(),
  /**
   * What a rule does when the provider never supplied the field it checks.
   * "pass" = unknown is not disqualifying; "fail" = exclude.
   */
  missingData: z.enum(["pass", "fail"]),
});

// ---------------------------------------------------------------------------
// Business rules
// ---------------------------------------------------------------------------

export const businessSchema = z.object({
  currency: z.string().length(3),

  priceBands: z
    .object({ budgetMax: nonNeg, standardMax: nonNeg })
    .refine((b) => b.budgetMax <= b.standardMax, { message: "budgetMax must be <= standardMax" }),

  conversion: z.object({
    /** Platform-wide click→call prior for astrologers with little data. */
    priorRate: unit,
    /** Impressions needed before observed conversion fully replaces the prior. */
    priorStrengthImpressions: posInt,
  }),

  revenue: z.object({
    /** Assumed call length (minutes) when an astrologer has no history. */
    defaultCallMinutes: z.number().positive(),
    /** Call length (minutes) that earns a full expected-duration score. */
    referenceCallMinutes: z.number().positive(),
    /** Revenue per call (currency units) mapped to a full score. */
    normalizationCeiling: z.number().positive(),
  }),

  margin: z.object({
    /** Minimum contribution margin; astrologers below it get no margin credit. */
    minMarginRate: unit,
    /** Margin rate mapped to a full score. */
    targetMarginRate: unit,
  }),

  /** Soft guardrails for the final list. */
  guardrails: z.object({
    /** Share of top-N slots that may exceed the standard price band. */
    maxPremiumShareTopN: unit,
    topN: posInt,
  }),
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  /** Desired share of top-N exposure, 0..1. */
  targetShare: unit,
  /** Hard floor / ceiling on exposure share. */
  share: range(unit),
  /** Platform revenue share on this provider's calls, 0..1. */
  revenueShare: unit,
  /** Concurrent consultations the provider can serve. */
  capacity: posInt,
});

export const providersSchema = z
  .object({
    providers: z.array(providerSchema).min(1),

    utilization: z.object({
      /** Window over which exposure share is measured. */
      windowMinutes: posInt,
      /** Exposure measured over this many top slots. */
      topN: posInt,
      /** Capacity usage above which the provider stops getting boosts. */
      saturationThreshold: unit,
      /** Exponential smoothing factor for measured shares. */
      smoothing: unit,
      /**
       * Live utilization = occupiedSupply / availableSupply from astrologer
       * statuses (busy / (online + busy)); used once a provider has at least
       * this many astrologers with a known live status.
       */
      liveMinSupply: posInt,
    }),

    /** Provider-level conversion tracking that tunes the booster/dampener. */
    performance: z.object({
      /** Window for provider impressions → completed calls. */
      windowHours: posInt,
      /** Pseudo-impressions pulling each provider's rate toward the platform rate. */
      priorStrengthImpressions: nonNeg,
      /** Reuse the computed performance for this long (per ranking clock). */
      cacheSeconds: z.number().int().nonnegative(),
    }),

    availability: z.object({
      /** Per-provider timeout for live availability calls. */
      timeoutMs: posInt,
      /** How long a fetched availability status is reused. */
      cacheSeconds: z.number().int().nonnegative(),
    }),

  })
  .superRefine((cfg, ctx) => {
    const enabled = cfg.providers.filter((p) => p.enabled);
    const total = enabled.reduce((s, p) => s + p.targetShare, 0);
    if (enabled.length && Math.abs(total - 1) > 1e-6) {
      ctx.addIssue({ code: "custom", message: `enabled provider targetShares must sum to 1 (got ${total.toFixed(4)})`, path: ["providers"] });
    }
    const ids = new Set<string>();
    cfg.providers.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", message: `duplicate provider id "${p.id}"`, path: ["providers", i, "id"] });
      ids.add(p.id);
      if (p.targetShare < p.share.min || p.targetShare > p.share.max) {
        ctx.addIssue({ code: "custom", message: "targetShare must lie within share.min..share.max", path: ["providers", i, "targetShare"] });
      }
    });
  });

// ---------------------------------------------------------------------------
// Exploration & diversity
// ---------------------------------------------------------------------------

export const explorationSchema = z.object({
  enabled: z.boolean(),

  /** Fraction of result slots reserved for exploration candidates. */
  slotShare: unit,
  /** Positions exploration candidates may occupy (1-based, inclusive). */
  slotPositions: range(z.number().int().positive()),

  newAstrologer: z.object({
    /** An astrologer counts as "new" until either limit is reached. */
    maxAgeDays: posInt,
    maxImpressions: posInt,
    /** Exploration signal value for a brand-new astrologer, decaying to 0. */
    initialBoost: unit,
  }),

  /** Uncertainty bonus for astrologers with few impressions (UCB-style). */
  uncertainty: z.object({ coefficient: nonNeg, minImpressions: posInt }),

  /** Keep exploration stable per session so results don't reshuffle on refresh. */
  seedBySession: z.boolean(),

  diversity: z.object({
    enabled: z.boolean(),
    /** Evaluated over the first N results. */
    windowSize: posInt,
    maxConsecutiveSameProvider: posInt,
    maxPerProviderInWindow: posInt,
    maxPerCategoryInWindow: posInt,
    /**
     * Minimum top-N slots per provider (providers[].share.min × topN, floored),
     * filled only by qualified candidates — never forced.
     */
    providerFloor: z.object({
      enabled: z.boolean(),
      /** A floor candidate may trail the best remaining candidate by at most this much score. */
      maxScoreGap: unit,
      /** Statuses that never fill a floor slot. */
      excludeStatuses: z.array(z.enum(["online", "busy", "offline", "unknown"])),
    }),
  }),

  /**
   * Exploration picks from under-target providers get priority × (1 + weight × gap
   * saturation) — only for candidates that pass the provider quality/relevance gates.
   */
  providerPriorityWeight: nonNeg,
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export const analyticsSchema = z.object({
  store: z.object({
    /** In-memory store keeps at most this many events per type (oldest dropped). */
    maxEventsPerType: posInt,
  }),
  ingestion: z.object({
    /** Max events accepted per client batch. */
    maxBatchSize: posInt,
  }),
  /** How far back to look for a user's earlier calls when counting repeat calls. */
  repeatLookbackDays: posInt,
  /** Default window for metrics queries. */
  defaultWindow: z.enum(["1h", "24h", "7d", "30d"]),
});

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export const userSchema = z.object({
  /** A language counts as preferred once this share of the user's calls used it. */
  derivedLanguageMinShare: unit,
  maxDerivedLanguages: posInt,
  maxFavorites: posInt,
  /** Previous astrologers returned to the engine, most recent first. */
  maxPreviousAstrologers: posInt,
});

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export const bookingSchema = z
  .object({
    /** Length of one bookable slot; every scheduled call is exactly one slot. */
    slotMinutes: posInt,
    /** How many days ahead (including today) users can book. */
    horizonDays: posInt,
    /** A slot must start at least this far in the future to be bookable. */
    minLeadMinutes: z.number().int().nonnegative(),
    /** The schedule's fixed offset from UTC (IST = 330, no DST). */
    utcOffsetMinutes: z.number().int().min(-720).max(840),
    timeZoneLabel: z.string().min(1),
    /** Default working hours in schedule-local minutes after midnight, [start, end). */
    workingHours: z.object({
      startMinute: z.number().int().min(0).max(1440),
      endMinute: z.number().int().min(0).max(1440),
    }),
    /** Upcoming bookings one user may hold at once (1: one booking = one call). */
    maxUpcomingPerUser: posInt,
    /** An instant ("talk now") call must be picked up within this many minutes, or it's missed. */
    instantPickupMinutes: posInt,
  })
  .superRefine((b, ctx) => {
    const { startMinute, endMinute } = b.workingHours;
    if (startMinute >= endMinute) {
      ctx.addIssue({ code: "custom", message: "workingHours.startMinute must be < endMinute", path: ["workingHours"] });
    }
    if ((endMinute - startMinute) % b.slotMinutes !== 0 || startMinute % b.slotMinutes !== 0) {
      ctx.addIssue({ code: "custom", message: "workingHours must align to slotMinutes", path: ["workingHours"] });
    }
  });

// ---------------------------------------------------------------------------
// Home feed
// ---------------------------------------------------------------------------

export const feedSchema = z.object({
  /** Astrologers per column. */
  columnSize: posInt,
  providerBalance: z.object({
    /**
     * Page-level provider weight = targetShare × exposure × capacity × efficiency:
     *   exposure   = clamp(1 + gapGain × gap/targetShare, exposureFactor)
     *   capacity   = clamp(1 + spareGain × (0.5 − utilization), capacityFactor); saturatedFactor at capacity
     *   efficiency = clamp(conversion ÷ platform rate, efficiencyFactor)
     * then held inside share.min/max (and maxPageShare) and renormalized.
     */
    gapGain: nonNeg,
    exposureFactor: range(nonNeg),
    spareGain: nonNeg,
    capacityFactor: range(nonNeg),
    efficiencyFactor: range(nonNeg),
    /** Weight multiplier for a provider at capacity. */
    saturatedFactor: unit,
    /** Hard page-share caps per provider id, tighter than share.max (e.g. never above target). */
    maxPageShare: z.record(z.string(), unit),
    /** Popular may exceed a provider's slot quota by this many. */
    popularSlack: z.number().int().nonnegative(),
  }),
  recommended: z
    .object({
      /** Slot shares for upper (2nd-ranked onwards), mid and lower rank bands. */
      bands: z.object({ upper: unit, mid: unit, lower: unit }).superRefine(sumsToOne("recommended.bands")),
      /** Rank percentiles where the mid and lower bands start. */
      midFrom: unit,
      lowerFrom: unit,
      /** Max score boost for an under-exposed provider with spare capacity (and dampening for over-exposed). */
      providerBoostMax: nonNeg,
    })
    .refine((r) => r.midFrom < r.lowerFrom, { message: "midFrom must be < lowerFrom" }),
  personalized: z.object({
    /** Liked / consulted astrologers pinned at the top. */
    maxPinned: z.number().int().nonnegative(),
    /** A rating at or above this counts as liked; at or below dislikedMaxRating (or a complaint) as disliked. */
    likedMinRating: z.number().min(1).max(5),
    dislikedMaxRating: z.number().min(1).max(5),
    ratingLookbackDays: posInt,
    /** Share of the non-pinned slots given to "similar to" astrologers, shown last. */
    relatedShare: unit,
    relatedMinSimilarity: unit,
    similarityWeights: z.object({ tags: nonNeg, languages: nonNeg, price: nonNeg }),
  }),
  premium: z.object({
    /** Premium = premium price band, or businessScore ≥ this, or one of these provider tiers. */
    minBusinessScore: unit,
    tiers: z.array(z.string().min(1)),
    /** Weight of availabilityScore when ordering premium astrologers. */
    availabilityWeight: nonNeg,
  }),
  /** Lower-band and premium picks must reach this qualityScore. */
  minQualityScore: unit,
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type SignalName = z.infer<typeof signalSchema>;
export type ScoreName = z.infer<typeof scoreSchema>;
export type UserSegment = (typeof USER_SEGMENTS)[number];
export type ScoreWeightProfile = Record<ScoreName, number>;
export type CatalogConfig = z.infer<typeof catalogSchema>;
export type RankingConfig = z.infer<typeof rankingSchema>;
export type EligibilityConfig = z.infer<typeof eligibilitySchema>;
export type BusinessConfig = z.infer<typeof businessSchema>;
export type ProvidersConfig = z.infer<typeof providersSchema>;
export type ProviderConfig = ProvidersConfig["providers"][number];
export type ExplorationConfig = z.infer<typeof explorationSchema>;
export type AnalyticsConfig = z.infer<typeof analyticsSchema>;
export type UserConfig = z.infer<typeof userSchema>;
export type BookingConfig = z.infer<typeof bookingSchema>;
export type FeedConfig = z.infer<typeof feedSchema>;
