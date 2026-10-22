import { config } from "@/config";
import { isBalanceQualified } from "../provider/gates";
import type { RankedCandidate, SignalContext } from "../types";

/*
 * Reserved premium slots (config.ranking.premiumSlots): positions 1..count go
 * to the best-ranked premium astrologers (business.priceBands premium) that
 * pass the provider quality/relevance gates and aren't offline. If fewer
 * qualify, the top-ranked remaining astrologers fill the rest. Everyone else
 * keeps their relative order below. Runs in Layer 5, before Thompson
 * sampling, in every bandit mode — so treatment and holdout share the same
 * top two.
 */

const isPremium = (c: RankedCandidate) => c.features.priceBand === 2;

export function reservePremiumSlots(order: readonly RankedCandidate[], sctx: SignalContext): RankedCandidate[] {
  const { enabled, count } = config.ranking.premiumSlots;
  if (!enabled || count === 0 || order.length === 0) return [...order];

  const n = Math.min(count, order.length);
  const premium = order.filter((c) => isPremium(c) && isBalanceQualified(c, sctx)).slice(0, n);
  // Not enough qualified premium astrologers: the top-ranked others fill the slots.
  const fillers = order.filter((c) => !premium.includes(c)).slice(0, n - premium.length);
  const chosen = new Set([...premium, ...fillers].map((c) => c.astrologer.id));

  const head = [...premium, ...fillers].map((c, i) => {
    const from = order.indexOf(c) + 1;
    const why = premium.includes(c) ? "premium slot" : "premium slot filled by a top-ranked astrologer (not enough qualified premium)";
    const note = from === i + 1 ? `${why} #${i + 1}` : `${why}: #${from} → #${i + 1}`;
    return { ...c, slot: "premium" as const, adjustments: [...c.adjustments, { stage: "premium" as const, note }] };
  });
  return [...head, ...order.filter((c) => !chosen.has(c.astrologer.id))];
}
