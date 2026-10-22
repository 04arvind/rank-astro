import type { CallInput, ClickInput, ImpressionInput, RatingInput } from "@/lib/analytics/ingest";
import { MINUTE_MS } from "@/lib/utils/time";
import type { AstrologerProfile } from "@/types/astrologer";
import { ASTRO } from "./astrologers";
import { daysAgo, hoursAgo } from "./time";
import type { UserKey } from "./user";

/*
 * Analytics history as record* inputs. Everything is generated from fixed
 * counts and offsets from NOW — no randomness — so metrics derived from it
 * are exact and repeatable.
 */

export interface HistorySet {
  impressions: ImpressionInput[];
  clicks: ClickInput[];
  calls: CallInput[];
  ratings: RatingInput[];
}

const empty = (): HistorySet => ({ impressions: [], clicks: [], calls: [], ratings: [] });

export function mergeHistory(...sets: HistorySet[]): HistorySet {
  return sets.reduce(
    (acc, s) => ({
      impressions: [...acc.impressions, ...s.impressions],
      clicks: [...acc.clicks, ...s.clicks],
      calls: [...acc.calls, ...s.calls],
      ratings: [...acc.ratings, ...s.ratings],
    }),
    empty(),
  );
}

// ---------------------------------------------------------------------------
// User call history
// ---------------------------------------------------------------------------

interface CallSpec {
  astrologer: AstrologerProfile;
  endedDaysAgo: number;
  minutes: number;
  status?: CallInput["status"];
  rating?: number;
}

function userCalls(userId: string, specs: CallSpec[]): HistorySet {
  const set = empty();
  specs.forEach((s, i) => {
    const callId = `${userId}-call-${i + 1}`;
    const endedAt = daysAgo(s.endedDaysAgo);
    set.calls.push({
      callId,
      userId,
      astrologerId: s.astrologer.id,
      providerId: s.astrologer.providerId,
      status: s.status ?? "completed",
      startedAt: endedAt - s.minutes * MINUTE_MS,
      endedAt,
      pricePerMinute: s.astrologer.pricing.perMinute,
    });
    if (s.rating !== undefined) {
      set.ratings.push({ callId, userId, astrologerId: s.astrologer.id, providerId: s.astrologer.providerId, rating: s.rating, timestamp: endedAt + MINUTE_MS });
    }
  });
  return set;
}

export const USER_HISTORY: Partial<Record<UserKey, HistorySet>> = {
  loyal: userCalls("user-returning-loyal", [
    { astrologer: ASTRO.meera, endedDaysAgo: 1, minutes: 20, rating: 5 },
    { astrologer: ASTRO.meera, endedDaysAgo: 3, minutes: 15, rating: 5 },
    { astrologer: ASTRO.meera, endedDaysAgo: 8, minutes: 25 },
    { astrologer: ASTRO.meera, endedDaysAgo: 15, minutes: 10, rating: 4 },
    { astrologer: ASTRO.dev, endedDaysAgo: 20, minutes: 12 },
  ]),
  budget: userCalls("user-budget", [
    { astrologer: ASTRO.harpreet, endedDaysAgo: 2, minutes: 10 },
    { astrologer: ASTRO.asha, endedDaysAgo: 6, minutes: 8 },
    { astrologer: ASTRO.harpreet, endedDaysAgo: 12, minutes: 12 },
    { astrologer: ASTRO.asha, endedDaysAgo: 25, minutes: 0, status: "missed" },
  ]),
  premium: userCalls("user-premium", [
    { astrologer: ASTRO.arjun, endedDaysAgo: 4, minutes: 40, rating: 5 },
    { astrologer: ASTRO.arjun, endedDaysAgo: 18, minutes: 35 },
    { astrologer: ASTRO.arjun, endedDaysAgo: 40, minutes: 45, rating: 5 },
  ]),
  lapsed: userCalls("user-lapsed", [{ astrologer: ASTRO.asha, endedDaysAgo: 150, minutes: 10 }]),
};

// ---------------------------------------------------------------------------
// Astrologer performance history (platform-wide, last ~30 days)
// ---------------------------------------------------------------------------

interface PerformanceSpec {
  impressions: number;
  clicks: number;
  completedCalls: number;
  missedCalls?: number;
  avgMinutes: number;
  /** Ratings left on completed calls, in order; complaints flagged separately. */
  ratings?: number[];
  complaints?: number;
  /** Spread events across this many days before NOW (≤ 30 to stay in the metrics window). */
  days?: number;
}

/** Deterministic events matching the given counts, spread evenly over `days`. */
export function performance(a: AstrologerProfile, spec: PerformanceSpec): HistorySet {
  const days = spec.days ?? 28;
  const at = (i: number, n: number) => Math.round(daysAgo(1 + (days - 1) * (i / Math.max(1, n))));
  const tag = a.sourceId;
  const set = empty();

  for (let i = 0; i < spec.impressions; i++) {
    set.impressions.push({ eventId: `perf-${tag}-imp-${i}`, timestamp: at(i, spec.impressions), astrologerId: a.id, providerId: a.providerId, position: (i % 10) + 1, sessionId: `perf-session-${i % 97}` });
  }
  for (let i = 0; i < spec.clicks; i++) {
    set.clicks.push({ eventId: `perf-${tag}-clk-${i}`, timestamp: at(i, spec.clicks), astrologerId: a.id, providerId: a.providerId, sessionId: `perf-session-${i % 97}` });
  }
  const totalCalls = spec.completedCalls + (spec.missedCalls ?? 0);
  for (let i = 0; i < totalCalls; i++) {
    const completed = i < spec.completedCalls;
    const endedAt = at(i, totalCalls);
    const minutes = completed ? spec.avgMinutes : 0;
    const callId = `perf-${tag}-call-${i}`;
    const userId = `perf-caller-${tag}-${i % Math.max(1, Math.ceil(totalCalls * 0.7))}`; // ~30% repeat callers
    set.calls.push({ callId, userId, astrologerId: a.id, providerId: a.providerId, status: completed ? "completed" : "missed", startedAt: endedAt - minutes * MINUTE_MS, endedAt, pricePerMinute: a.pricing.perMinute });
    const rating = completed ? spec.ratings?.[i] : undefined;
    if (rating !== undefined) {
      set.ratings.push({ callId, userId, astrologerId: a.id, providerId: a.providerId, rating, complaint: i < (spec.complaints ?? 0), timestamp: endedAt + MINUTE_MS });
    }
  }
  return set;
}

const repeat = (n: number, v: number) => Array.from({ length: n }, () => v);

export const PERFORMANCE: Record<string, HistorySet> = {
  /** Strong converter: 3.75% impression→call, long calls, great ratings. */
  arjun: performance(ASTRO.arjun, { impressions: 800, clicks: 60, completedCalls: 30, missedCalls: 2, avgMinutes: 22, ratings: repeat(20, 5) }),
  /** Solid performer. */
  meera: performance(ASTRO.meera, { impressions: 500, clicks: 40, completedCalls: 25, avgMinutes: 18, ratings: [...repeat(15, 5), ...repeat(5, 4)] }),
  /** Plenty of exposure, weak conversion and short calls. */
  asha: performance(ASTRO.asha, { impressions: 400, clicks: 12, completedCalls: 4, missedCalls: 3, avgMinutes: 5, ratings: [4, 4, 3] }),
  /** Busy, well-rated, but many complaints → 8/20 = 40% complaint rate. */
  complaints: performance(ASTRO.complaints, { impressions: 300, clicks: 30, completedCalls: 20, avgMinutes: 9, ratings: [...repeat(8, 2), ...repeat(12, 4)], complaints: 8 }),
  /** Moderate exposure, decent results. */
  dev: performance(ASTRO.dev, { impressions: 250, clicks: 18, completedCalls: 9, avgMinutes: 14, ratings: repeat(6, 5) }),
  // tara: intentionally no history (brand new).
};

/** Platform history used by most scenarios. */
export const BASE_HISTORY: HistorySet = mergeHistory(...Object.values(PERFORMANCE));

/** A burst of very recent activity, for tests that care about "right now". */
export const RECENT_BURST: HistorySet = {
  ...empty(),
  impressions: Array.from({ length: 20 }, (_, i) => ({ eventId: `burst-${i}`, timestamp: hoursAgo(1), astrologerId: ASTRO.rupa.id, providerId: ASTRO.rupa.providerId, position: (i % 5) + 1 })),
};

/** `n` recent impressions of one astrologer to one viewer (session), for fatigue cases. */
export function viewerImpressions(a: AstrologerProfile, sessionId: string, n: number, userId?: string): HistorySet {
  return {
    ...empty(),
    impressions: Array.from({ length: n }, (_, i) => ({
      eventId: `viewer-${sessionId}-${a.sourceId}-${i}`,
      timestamp: hoursAgo(1 + i),
      astrologerId: a.id,
      providerId: a.providerId,
      position: 1 + (i % 3),
      sessionId,
      userId,
    })),
  };
}
