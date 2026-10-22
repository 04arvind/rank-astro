import { config } from "@/config";
import { ratio } from "@/lib/utils/math";
import { overlapMs, SECOND_MS } from "@/lib/utils/time";
import type { CallEvent, ProviderMetrics, TimeRange } from "@/types/analytics";
import type { RankingStats, RankingStatsQuery, StatsWindow } from "@/types/ranking";
import { groupBy } from "@/lib/utils/collections";
import { clicksByProvider } from "./clicks";
import { impressionsByProvider, topNImpressionsByProvider } from "./impressions";
import { getAnalyticsStore } from "./store";
import { toRange } from "./window";

/** Highest number of simultaneous calls, with each call clipped to the range. */
function peakConcurrency(calls: readonly CallEvent[], range: TimeRange): number {
  const edges: [number, 1 | -1][] = [];
  for (const c of calls) {
    const start = Math.max(c.startedAt, range.from);
    const end = Math.min(c.endedAt, range.to);
    if (end > start) edges.push([start, 1], [end, -1]);
  }
  // Ends sort before starts at the same instant so back-to-back calls don't overlap.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function clippedSeconds(calls: readonly CallEvent[], range: TimeRange): number {
  return calls.reduce((s, c) => s + overlapMs(c.startedAt, c.endedAt, range) / SECOND_MS, 0);
}

export interface ProviderMetricsQuery {
  window: StatsWindow | TimeRange;
  providerId?: string;
}

/** Exposure, engagement, revenue and capacity utilization per provider. */
export async function getProviderMetrics({ window, providerId }: ProviderMetricsQuery): Promise<ProviderMetrics[]> {
  const range = toRange(window);
  const store = getAnalyticsStore();
  const { topN } = config.providers.utilization;

  const [impressions, clicks, calls] = await Promise.all([
    store.query({ type: "impression", range }),
    store.query({ type: "click", range }),
    store.query({ type: "call", range }),
  ]);

  const impCounts = impressionsByProvider(impressions);
  const topCounts = topNImpressionsByProvider(impressions, topN);
  const clickCounts = clicksByProvider(clicks);
  const callsByProvider = groupBy(calls, (c) => c.providerId);
  const totalTop = [...topCounts.values()].reduce((a, b) => a + b, 0);
  const windowSeconds = (range.to - range.from) / 1000;

  // Configured providers always appear; unknown ones appear if they have activity.
  const configured = new Map(config.providers.providers.map((p) => [p.id, p]));
  const ids = new Set([...configured.keys(), ...impCounts.keys(), ...callsByProvider.keys()]);

  const out: ProviderMetrics[] = [];
  for (const id of ids) {
    if (providerId && id !== providerId) continue;
    const cfg = configured.get(id);
    const providerCalls = callsByProvider.get(id) ?? [];
    const completed = providerCalls.filter((c) => c.status === "completed");
    const gross = completed.reduce((s, c) => s + c.grossAmount, 0);
    const imp = impCounts.get(id) ?? 0;
    const capacitySeconds = cfg ? cfg.capacity * windowSeconds : 0;

    out.push({
      providerId: id,
      impressions: imp,
      topNImpressions: topCounts.get(id) ?? 0,
      clicks: clickCounts.get(id) ?? 0,
      calls: providerCalls.length,
      completedCalls: completed.length,
      grossRevenue: gross,
      platformRevenue: gross * (cfg?.revenueShare ?? 0),
      exposureShare: ratio(topCounts.get(id) ?? 0, totalTop) ?? 0,
      targetShare: cfg?.targetShare,
      capacity: cfg?.capacity,
      avgUtilization: ratio(clippedSeconds(completed, range), capacitySeconds),
      peakUtilization: cfg ? ratio(peakConcurrency(completed, range), cfg.capacity) : null,
      ctr: ratio(clickCounts.get(id) ?? 0, imp),
      conversionRate: ratio(completed.length, imp),
    });
  }
  return out.sort((a, b) => b.exposureShare - a.exposureShare || a.providerId.localeCompare(b.providerId));
}

/** Provider metrics in the shape served by /api/admin/ranking/stats. */
export async function getRankingStats({ window, providerId }: RankingStatsQuery): Promise<RankingStats> {
  const providers = await getProviderMetrics({ window, providerId });
  return {
    window,
    generatedAt: new Date().toISOString(),
    providers: providers.map((p) => ({
      providerId: p.providerId,
      impressions: p.impressions,
      clicks: p.clicks,
      calls: p.completedCalls,
      exposureShare: p.exposureShare,
      targetShare: p.targetShare,
      conversionRate: p.conversionRate,
      utilization: [p.avgUtilization, p.peakUtilization].reduce<number | null>((m, v) => (v === null ? m : Math.max(m ?? 0, v)), null),
    })),
  };
}
