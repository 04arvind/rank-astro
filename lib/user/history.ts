import { config } from "@/config";
import { getUserCallSummary } from "@/lib/analytics";
import { toShares } from "@/lib/utils/normalization";
import { DAY_MS, lastPeriod } from "@/lib/utils/time";
import type { UserCallSummary } from "@/types/analytics";
import type { AstrologerProfile } from "@/types/astrologer";
import type { PreviousAstrologer } from "@/types/user";

/** Completed calls within config.ranking.segmentation.historyWindowDays. */
export async function getCallHistory(userId: string, now = Date.now()): Promise<UserCallSummary> {
  const days = config.ranking.segmentation.historyWindowDays;
  return getUserCallSummary(userId, lastPeriod(days * DAY_MS, now));
}

/** Astrologers the user has completed calls with, most recent first. */
export function previousAstrologers(history: UserCallSummary | undefined): PreviousAstrologer[] {
  return (history?.astrologers ?? [])
    .map((h) => ({
      astrologerId: h.astrologerId,
      providerId: h.providerId,
      completedCalls: h.completedCalls,
      totalSpend: h.totalSpend,
      lastCallAt: h.lastCallAt,
    }))
    .sort((a, b) => b.lastCallAt - a.lastCallAt)
    .slice(0, config.user.maxPreviousAstrologers);
}

export interface Affinities {
  category: Map<string, number>;
  language: Map<string, number>;
  provider: Map<string, number>;
}

/**
 * Where the user's completed calls went, as shares of calls: per
 * category/specialization tag, per language spoken, per provider.
 * `called` are the profiles of astrologers in the history.
 */
export function computeAffinities(
  history: UserCallSummary | undefined,
  called: readonly AstrologerProfile[],
): Affinities {
  const byId = new Map(called.map((a) => [a.id, a]));
  const tags = new Map<string, number>();
  const languages = new Map<string, number>();
  const providers = new Map<string, number>();
  let total = 0;

  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const h of history?.astrologers ?? []) {
    const a = byId.get(h.astrologerId);
    const n = h.completedCalls;
    total += n;
    add(providers, h.providerId, n);
    for (const t of new Set([...(a?.categories ?? []), ...(a?.specializations ?? [])])) add(tags, t, n);
    for (const l of a?.languages ?? []) add(languages, l, n);
  }

  return { category: toShares(tags, total), language: toShares(languages, total), provider: toShares(providers, total) };
}
