import type { ProvidersConfig } from "./schema";

/**
 * Provider utilization targets and boost limits.
 * `id` must match the adapters in lib/providers/.
 */
export const providerConfig = {
  // Enabled providers' targetShares must sum to 1.
  providers: [
    {
      id: "providerA",
      name: "Astropatri",
      enabled: true,
      targetShare: 0.4,
      share: { min: 0.2, max: 0.6 },
      revenueShare: 0.35,
      capacity: 200,
    },
    {
      id: "providerB",
      name: "Talk to Guruji",
      enabled: true,
      targetShare: 0.35,
      share: { min: 0.15, max: 0.55 },
      revenueShare: 0.3,
      capacity: 150,
    },
    {
      id: "providerC",
      name: "Provider C",
      enabled: true,
      targetShare: 0.25,
      share: { min: 0.1, max: 0.45 },
      revenueShare: 0.4,
      capacity: 80,
    },
  ],

  utilization: {
    windowMinutes: 60,
    topN: 10,
    saturationThreshold: 0.85,
    smoothing: 0.3,
    liveMinSupply: 3,
  },

  performance: {
    windowHours: 24,
    priorStrengthImpressions: 200,
    cacheSeconds: 30,
  },

  availability: {
    timeoutMs: 1500,
    cacheSeconds: 30,
  },

} satisfies ProvidersConfig;
