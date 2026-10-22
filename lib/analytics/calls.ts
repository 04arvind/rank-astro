import { config } from "@/config";
import { ratio } from "@/lib/utils/math";
import type {
  CallEvent,
  RatingEvent,
  TimeRange,
  UserAstrologerHistory,
  UserCallSummary,
} from "@/types/analytics";
import { groupBy } from "@/lib/utils/collections";
import {
  callInput,
  parseInput,
  ratingInput,
  withMeta,
  type CallInput,
  type RatingInput,
} from "./ingest";
import { getAnalyticsStore } from "./store";
import { DAY_MS } from "@/lib/utils/time";

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export async function recordCall(input: CallInput): Promise<CallEvent> {
  const c = parseInput(callInput, input);
  const durationSeconds = c.status === "completed" ? Math.round((c.endedAt - c.startedAt) / 1000) : 0;
  const event: CallEvent = {
    type: "call",
    ...withMeta(c),
    // Calls are indexed by when they ended so a window only holds finished calls.
    timestamp: c.endedAt,
    durationSeconds,
    grossAmount: c.grossAmount ?? (durationSeconds / 60) * c.pricePerMinute,
  };
  await getAnalyticsStore().append([event]);
  return event;
}

export async function recordRating(input: RatingInput): Promise<RatingEvent> {
  const event: RatingEvent = { type: "rating", ...withMeta(parseInput(ratingInput, input)) };
  await getAnalyticsStore().append([event]);
  return event;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface CallSummary {
  calls: number;
  completedCalls: number;
  missedCalls: number;
  totalCallSeconds: number;
  grossRevenue: number;
  uniqueCallers: number;
  repeatCalls: number;
}

/**
 * Per-astrologer call totals. `priorCalls` are completed calls from before the
 * window, used to tell whether a caller had already consulted this astrologer.
 */
export function summarizeCallsByAstrologer(
  calls: readonly CallEvent[],
  priorCalls: readonly CallEvent[] = [],
): Map<string, CallSummary> {
  const seen = new Set(
    priorCalls.filter((c) => c.status === "completed").map((c) => `${c.astrologerId}:${c.userId}`),
  );
  const ordered = [...calls].sort((a, b) => a.startedAt - b.startedAt);
  const out = new Map<string, CallSummary>();

  for (const [astrologerId, list] of groupBy(ordered, (c) => c.astrologerId)) {
    const s: CallSummary = {
      calls: list.length,
      completedCalls: 0,
      missedCalls: 0,
      totalCallSeconds: 0,
      grossRevenue: 0,
      uniqueCallers: new Set(list.map((c) => c.userId)).size,
      repeatCalls: 0,
    };
    for (const c of list) {
      if (c.status === "missed" || c.status === "rejected") s.missedCalls++;
      if (c.status !== "completed") continue;
      s.completedCalls++;
      s.totalCallSeconds += c.durationSeconds;
      s.grossRevenue += c.grossAmount;
      const pair = `${astrologerId}:${c.userId}`;
      if (seen.has(pair)) s.repeatCalls++;
      else seen.add(pair);
    }
    out.set(astrologerId, s);
  }
  return out;
}

export interface RatingSummary {
  ratingCount: number;
  ratingSum: number;
  complaints: number;
}

export function summarizeRatingsByAstrologer(ratings: readonly RatingEvent[]): Map<string, RatingSummary> {
  const out = new Map<string, RatingSummary>();
  for (const [astrologerId, list] of groupBy(ratings, (r) => r.astrologerId)) {
    out.set(astrologerId, {
      ratingCount: list.length,
      ratingSum: list.reduce((s, r) => s + r.rating, 0),
      complaints: list.filter((r) => r.complaint).length,
    });
  }
  return out;
}

/** Completed calls from before `range`, for repeat-call detection. */
export async function getPriorCalls(range: TimeRange, astrologerIds?: readonly string[]) {
  return getAnalyticsStore().query({
    type: "call",
    range: { from: range.from - config.analytics.repeatLookbackDays * DAY_MS, to: range.from - 1 },
    astrologerIds,
  });
}

/** A user's completed-call history — input for personalisation signals. */
export async function getUserCallSummary(userId: string, range: TimeRange): Promise<UserCallSummary> {
  const calls = (await getAnalyticsStore().query({ type: "call", range, userId })).filter(
    (c) => c.status === "completed",
  );

  const astrologers: UserAstrologerHistory[] = [];
  for (const [astrologerId, list] of groupBy(calls, (c) => c.astrologerId)) {
    const seconds = list.reduce((s, c) => s + c.durationSeconds, 0);
    const spend = list.reduce((s, c) => s + c.grossAmount, 0);
    astrologers.push({
      astrologerId,
      providerId: list[0].providerId,
      completedCalls: list.length,
      totalCallSeconds: seconds,
      totalSpend: spend,
      lastCallAt: Math.max(...list.map((c) => c.endedAt)),
      avgPricePerMinute: list.reduce((s, c) => s + c.pricePerMinute, 0) / list.length,
    });
  }
  astrologers.sort((a, b) => b.lastCallAt - a.lastCallAt);

  return {
    userId,
    completedCalls: calls.length,
    totalSpend: calls.reduce((s, c) => s + c.grossAmount, 0),
    avgPricePerMinute: ratio(calls.reduce((s, c) => s + c.pricePerMinute, 0), calls.length),
    astrologers,
  };
}
