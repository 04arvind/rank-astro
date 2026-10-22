/**
 * Analytics: records raw events and derives observed metrics.
 * The ranking engine reads from here; it never computes these itself.
 */
export { recordImpressions } from "./impressions";
export { recordClicks } from "./clicks";
export { recordCall, recordRating, getUserCallSummary } from "./calls";
export { getAstrologerMetrics, type AstrologerMetricsQuery } from "./metrics";
export { getExposureSnapshot, type AstrologerExposure, type ExposureQuery, type ExposureSnapshot } from "./exposure";
export { getProviderMetrics, getRankingStats, type ProviderMetricsQuery } from "./proiverMetrics";
export { getAnalyticsStore, setAnalyticsStore, InMemoryAnalyticsStore, type AnalyticsStore } from "./store";
export { clickInput, impressionInput, type ClickInput, type ImpressionInput } from "./ingest";
export { toRange } from "./window";
