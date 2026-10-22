import type { BusinessConfig } from "./schema";

/** Commercial rules and thresholds used by lib/ranking/business. */
export const businessConfig = {
  currency: "INR",

  // ₹/min: budget ≤ 20 < standard ≤ 60 < premium
  priceBands: { budgetMax: 20, standardMax: 60 },

  conversion: {
    priorRate: 0.08,
    priorStrengthImpressions: 200,
  },

  revenue: {
    defaultCallMinutes: 8,
    referenceCallMinutes: 16,
    normalizationCeiling: 1500,
  },

  margin: {
    minMarginRate: 0.1,
    targetMarginRate: 0.4,
  },

  guardrails: {
    maxPremiumShareTopN: 0.3,
    topN: 10,
  },
} satisfies BusinessConfig;
