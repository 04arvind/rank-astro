import type { RankingConfig } from "./schema";

/**
 * Ranking engine tunables: signal weights per user segment and the
 * parameters each signal function reads. Validated in config/index.ts.
 */
export const rankingConfig = {
  engine: { name: "weighted-score", version: "2.0.0" },

  metricsWindow: "30d",
  // A visitor's ranking is computed once per this many seconds (per filter set) and reused,
  // so refreshes, the astrologers page and the admin dashboard show the same order. 0 = off.
  stableListSeconds: 300,
  neutralValue: 0.5,

  explanation: {
    maxUserReasons: 3,
    minContribution: 0.01,
    minSignalValue: 0.6,
    // Personal history is the most meaningful reason a user can see.
    priority: ["repeatAstrologer", "categoryMatch"],
  },

  pagination: {
    defaultLimit: 20,
    maxLimit: 100,
    /** Candidates scored per request before pagination. */
    maxCandidates: 500,
  },

  segmentation: {
    returningUserMinCalls: 1,
    historyWindowDays: 180,
  },

  // baseScore weights per segment; each profile must sum to 1.
  scoreWeights: {
    // No history: relevance and proven quality dominate.
    newUser: {
      qualityScore: 0.26,
      personalizationScore: 0.04,
      businessScore: 0.12,
      priceScore: 0.06,
      categoryScore: 0.14,
      availabilityScore: 0.12,
      explorationScore: 0.06,
      languageScore: 0.14,
      diversityScore: 0.06,
    },
    // Has history or favourites: personal fit carries more weight.
    returningUser: {
      qualityScore: 0.2,
      personalizationScore: 0.22,
      businessScore: 0.1,
      priceScore: 0.08,
      categoryScore: 0.1,
      availabilityScore: 0.1,
      explorationScore: 0.03,
      languageScore: 0.1,
      diversityScore: 0.07,
    },
  },

  // Component blend inside each composite score; each must sum to 1.
  components: {
    qualityScore: {
      rating: 0.35,
      reviewConfidence: 0.15,
      experience: 0.15,
      completionRate: 0.1,
      acceptanceRate: 0.1,
      complaintFree: 0.1,
      repeatRate: 0.05,
    },
    personalizationScore: { repeatAstrologer: 0.45, categoryAffinity: 0.25, languageAffinity: 0.15, providerAffinity: 0.15 },
    businessScore: { expectedRevenue: 0.35, contributionMargin: 0.25, conversion: 0.25, expectedDuration: 0.15 },
    categoryScore: { categoryMatch: 0.7, specializationMatch: 0.3 },
    availabilityScore: { availabilityStatus: 0.6, callReady: 0.2, providerCapacity: 0.2 },
  },

  adjustments: {
    providerBooster: {
      min: 0,
      max: 0.08,
      saturationGap: 0.2,
      minQualityScore: 0.5,
      minRelevance: 0.5,
      maxRelativeToBase: 0.2,
      performance: { enabled: true, minFactor: 0.5 },
      dampener: { enabled: true, max: 0.05, saturationGap: 0.2, utilizationFrom: 0.75, exemptPersonal: true },
    },
    quotaUrgency: {
      max: 0.05,
      periodHours: 24,
      timezoneOffsetMinutes: 330, // IST
      timePressureExponent: 1.5,
      minPeriodImpressions: 50,
      astrologerQuotas: {},
      minQualityScore: 0.5,
      minRelevance: 0.5,
      maxRelativeToBase: 0.15,
    },
    frequencyPenalty: {
      windowHours: 24,
      freeUserImpressions: 3,
      perUserImpression: 0.02,
      globalOverexposureMultiple: 2,
      perExcessShare: 0.02,
      minWindowImpressions: 100,
      max: 0.1,
      exemptPersonal: true,
    },
  },

  // Added on top of finalScore (see schema): small weights so they refine,
  // not overturn, the existing order.
  extension: {
    enabled: true,
    weights: {
      conversionScore: 0.04,
      retentionScore: 0.03,
      quotaUrgencyScore: 0.02,
    },
    conversion: { priorRate: 0.15, priorStrengthClicks: 20 },
    retention: { priorRate: 0.2, priorStrengthCalls: 10 },
    quotaUrgency: { minPeriodImpressions: 50 },
    penalties: {
      overExposure: { weight: 0.02, startMultiple: 2, fullMultiple: 5, minImpressions: 200, exemptPersonal: true },
      lowQuality: { weight: 0.05, threshold: 0.45 },
      // Offline astrologers are still eligible (eligibility.availability.includeOffline).
      unavailable: { weight: 0.03, byStatus: { online: 0, busy: 0.2, offline: 1, unknown: 0 } },
    },
  },

  // Layer 3: Thompson sampling decides the top slots of User-Choice lists
  // (lib/ranking/bandit); scores are untouched. Rollback: BANDIT_MODE=off
  // (env) or the admin flag; bump policyVersion to relearn.
  bandit: {
    mode: "live",
    policyVersion: "ts-1",
    // Thompson picks are shown only in positions firstSlot..slots (3–4, the rest of the first row); 1–2 are premium slots.
    firstSlot: 3,
    slots: 4,
    poolSize: 60,
    layer2PriorExponent: 2,
    pinPersonal: true,
    holdoutShare: 0.1,
    objective: { completion: 0.5, profit: 0.5 },
    prior: { rate: 0.02, providerStrength: 500, astrologerStrength: 100, contextStrength: 20 },
    positionDecay: 5,
    exposureDedupHours: 24,
    attributionHours: 72,
    sampleStableSeconds: 300,
    cacheSeconds: 30,
    gates: { minQualityScore: 0.5, minRelevance: 0.5 },
    reconcile: { intervalSeconds: 60, lookbackHours: 6, leaseSeconds: 120 },
    retentionDays: 120,
    // Lifts the reward of under-target providers' qualified astrologers (fair exposure).
    fairness: { weight: 0.1 },
  },

  // Layer 5, before Thompson sampling: positions 1..count go to the top-ranked
  // qualified premium astrologers (top-ranked others if not enough qualify).
  premiumSlots: { enabled: true, count: 2 },

  // Layer 4: XGBoost LambdaMART ranker (lib/ranking/ml). Used only when a
  // trained model is present and passes the data gates; otherwise the
  // Layer-3 order passes through unchanged. Rollback: RANKER_MODE=off.
  ml: {
    enabled: true,
    modelPath: "data/models/ranker.json",
    shortlistSize: 60,
    blendWeight: 0.5,
    gates: { minTrainingQueries: 200, minPositiveQueries: 30, requireLiftOverBaseline: true, maxModelAgeDays: 45 },
    cacheSeconds: 60,
    trainingLog: { enabled: true, maxItemsPerRequest: 50, retentionDays: 90 },
  },

  // Layer 6: last checks before results are served.
  finalRerank: {
    revalidate: true,
    dedupe: true,
    enforceConstraints: true,
    exemptPersonal: true,
  },

  signals: {
    rating: { priorMean: 4.0, priorWeight: 20, scaleMax: 5 },
    reviewConfidence: { halfAtReviews: 50 },
    experience: { saturationYears: 15 },
    completion: { targetCallMinutes: 15 },
    availability: { scores: { online: 1, busy: 0.4, offline: 0, unknown: 0.5 } },
    categoryMatch: { primary: 1, secondary: 0.6, none: 0 },
    languageMatch: { exact: 1, partial: 0.5, none: 0 },
    priceAffinity: { tolerance: 0.3 },
    repeatAstrologer: { favoriteValue: 0.8, recencyHalfLifeDays: 30, saturationCalls: 5 },
  },
} satisfies RankingConfig;
