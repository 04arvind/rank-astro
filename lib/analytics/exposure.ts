import { countBy } from "@/lib/utils/collections";
import type { TimeRange } from "@/types/analytics";
import { getAnalyticsStore } from "./store";

export interface ExposureQuery {
  /** "Shown recently" window, for frequency/fatigue. */
  recent: TimeRange;
  /** Current quota period, for quota progress. */
  period: TimeRange;
  /** Only positions 1..topN count toward provider share. */
  topN: number;
  /** Impressions to this user or session count as "seen by this viewer". */
  userId?: string;
  sessionId?: string;
}

export interface AstrologerExposure {
  /** Impressions to this user/session in the recent window. */
  viewer: number;
  /** All impressions in the recent window. */
  global: number;
  /** All impressions in the current quota period. */
  period: number;
}

export interface ExposureSnapshot {
  byAstrologer: Map<string, AstrologerExposure>;
  recentTotal: number;
  period: {
    topNTotal: number;
    /** Provider share of top-N impressions in the period (0..1). */
    providerShare: Map<string, number>;
  };
}

/**
 * Exposure counts the ranking engine needs for frequency penalties and quota
 * urgency. Pure counting — interpretation lives in lib/ranking.
 */
export async function getExposureSnapshot(q: ExposureQuery): Promise<ExposureSnapshot> {
  const store = getAnalyticsStore();
  const from = Math.min(q.recent.from, q.period.from);
  const to = Math.max(q.recent.to, q.period.to);
  const all = await store.query({ type: "impression", range: { from, to } });

  const inRange = (t: number, r: TimeRange) => t >= r.from && t <= r.to;
  const recent = all.filter((e) => inRange(e.timestamp, q.recent));
  const period = all.filter((e) => inRange(e.timestamp, q.period));
  const isViewer = (e: (typeof all)[number]) =>
    (q.userId !== undefined && e.userId === q.userId) || (q.sessionId !== undefined && e.sessionId === q.sessionId);

  const viewer = countBy(recent.filter(isViewer), (e) => e.astrologerId);
  const global = countBy(recent, (e) => e.astrologerId);
  const inPeriod = countBy(period, (e) => e.astrologerId);

  const byAstrologer = new Map<string, AstrologerExposure>();
  for (const id of new Set([...global.keys(), ...inPeriod.keys()])) {
    byAstrologer.set(id, { viewer: viewer.get(id) ?? 0, global: global.get(id) ?? 0, period: inPeriod.get(id) ?? 0 });
  }

  const topN = period.filter((e) => e.position <= q.topN);
  const providerCounts = countBy(topN, (e) => e.providerId);
  return {
    byAstrologer,
    recentTotal: recent.length,
    period: {
      topNTotal: topN.length,
      providerShare: new Map([...providerCounts].map(([k, v]) => [k, topN.length ? v / topN.length : 0])),
    },
  };
}
