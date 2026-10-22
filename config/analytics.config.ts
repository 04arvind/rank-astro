import type { AnalyticsConfig } from "./schema";

/** Event collection and metrics settings for lib/analytics. */
export const analyticsConfig = {
  store: { maxEventsPerType: 200_000 },
  ingestion: { maxBatchSize: 100 },
  repeatLookbackDays: 180,
  defaultWindow: "24h",
} satisfies AnalyticsConfig;
