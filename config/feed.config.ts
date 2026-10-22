import type { FeedConfig } from "./schema";

/** Home page columns (lib/feed): what each column picks and how providers share the page. */
export const feedConfig = {
  columnSize: 6,

  providerBalance: {
    gapGain: 1,
    exposureFactor: { min: 0.6, max: 1.8 },
    spareGain: 0.6,
    capacityFactor: { min: 0.7, max: 1.3 },
    efficiencyFactor: { min: 0.85, max: 1.15 },
    saturatedFactor: 0.3,
    // Provider A has the most supply: never give it more than its target share of the page.
    maxPageShare: { providerA: 0.4 },
    popularSlack: 1,
  },

  recommended: {
    bands: { upper: 0.4, mid: 0.35, lower: 0.25 },
    midFrom: 0.3,
    lowerFrom: 0.65,
    providerBoostMax: 0.05,
  },

  personalized: {
    maxPinned: 3,
    likedMinRating: 4,
    dislikedMaxRating: 2,
    ratingLookbackDays: 180,
    relatedShare: 0.5,
    relatedMinSimilarity: 0.35,
    similarityWeights: { tags: 0.5, languages: 0.3, price: 0.2 },
  },

  premium: {
    minBusinessScore: 0.65,
    tiers: ["T1"],
    availabilityWeight: 0.1,
  },

  minQualityScore: 0.5,
} satisfies FeedConfig;
