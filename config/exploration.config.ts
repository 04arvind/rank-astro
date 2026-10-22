import type { ExplorationConfig } from "./schema";

/** Exploration (new/under-exposed astrologers) and result diversity. */
export const explorationConfig = {
  enabled: true,

  slotShare: 0.1,
  slotPositions: { min: 4, max: 20 },

  newAstrologer: {
    maxAgeDays: 30,
    maxImpressions: 1000,
    initialBoost: 1,
  },

  uncertainty: { coefficient: 0.5, minImpressions: 50 },

  seedBySession: true,

  diversity: {
    enabled: true,
    windowSize: 10,
    maxConsecutiveSameProvider: 2,
    maxPerProviderInWindow: 5,
    maxPerCategoryInWindow: 6,
    providerFloor: { enabled: true, maxScoreGap: 0.15, excludeStatuses: ["offline"] },
  },

  providerPriorityWeight: 0.5,
} satisfies ExplorationConfig;
