import { ratio } from "@/lib/utils/math";
import type { AstrologerMetrics, TimeRange } from "@/types/analytics";
import type { StatsWindow } from "@/types/ranking";
import { getPriorCalls, summarizeCallsByAstrologer, summarizeRatingsByAstrologer } from "./calls";
import { clicksByAstrologer } from "./clicks";
import { impressionsByAstrologer } from "./impressions";
import { getAnalyticsStore } from "./store";
import { toRange } from "./window";

export interface AstrologerMetricsQuery {
  window: StatsWindow | TimeRange;
  /** Limit to these astrologers; all with activity when omitted. */
  astrologerIds?: readonly string[];
}

/**
 * Observed performance per astrologer — the read model the ranking engine
 * consumes. Astrologers with no activity in the window are omitted; callers
 * treat a missing entry as "no data".
 */
export async function getAstrologerMetrics({
  window,
  astrologerIds,
}: AstrologerMetricsQuery): Promise<Map<string, AstrologerMetrics>> {
  const range = toRange(window);
  const store = getAnalyticsStore();
  const q = { range, astrologerIds };

  const [impressions, clicks, calls, ratings, priorCalls] = await Promise.all([
    store.query({ type: "impression", ...q }),
    store.query({ type: "click", ...q }),
    store.query({ type: "call", ...q }),
    store.query({ type: "rating", ...q }),
    getPriorCalls(range, astrologerIds),
  ]);

  const impressionCounts = impressionsByAstrologer(impressions);
  const clickCounts = clicksByAstrologer(clicks);
  const callSummaries = summarizeCallsByAstrologer(calls, priorCalls);
  const ratingSummaries = summarizeRatingsByAstrologer(ratings);

  // Provider per astrologer, from whichever event mentions it.
  const providerOf = new Map<string, string>();
  for (const e of [...impressions, ...clicks, ...calls, ...ratings]) {
    if (!providerOf.has(e.astrologerId)) providerOf.set(e.astrologerId, e.providerId);
  }

  const out = new Map<string, AstrologerMetrics>();
  for (const [astrologerId, providerId] of providerOf) {
    const imp = impressionCounts.get(astrologerId) ?? 0;
    const clk = clickCounts.get(astrologerId) ?? 0;
    const c = callSummaries.get(astrologerId);
    const r = ratingSummaries.get(astrologerId);
    const completed = c?.completedCalls ?? 0;
    const missed = c?.missedCalls ?? 0;
    const revenue = c?.grossRevenue ?? 0;
    const ratingCount = r?.ratingCount ?? 0;

    out.set(astrologerId, {
      astrologerId,
      providerId,
      impressions: imp,
      clicks: clk,
      calls: c?.calls ?? 0,
      completedCalls: completed,
      missedCalls: missed,
      totalCallSeconds: c?.totalCallSeconds ?? 0,
      grossRevenue: revenue,
      uniqueCallers: c?.uniqueCallers ?? 0,
      repeatCalls: c?.repeatCalls ?? 0,
      ratingCount,
      ratingSum: r?.ratingSum ?? 0,
      complaints: r?.complaints ?? 0,
      ctr: ratio(clk, imp),
      clickToCallRate: ratio(completed, clk),
      conversionRate: ratio(completed, imp),
      responseRate: ratio(completed, completed + missed),
      repeatRate: ratio(c?.repeatCalls ?? 0, completed),
      avgCallSeconds: ratio(c?.totalCallSeconds ?? 0, completed),
      avgRating: ratio(r?.ratingSum ?? 0, ratingCount),
      complaintRate: ratio(r?.complaints ?? 0, ratingCount),
      revenuePerImpression: ratio(revenue, imp),
    });
  }
  return out;
}
