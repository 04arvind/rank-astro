import { config } from "@/config";
import type { FeatureVector } from "@/lib/astrologer";
import { clamp, hashUnit } from "@/lib/utils/math";
import { isBalanceQualified } from "../provider/gates";
import type { RankedCandidate, Signal, SignalContext } from "../types";

/** New (young, under-exposed) or too little data to judge. */
export function isExplorationCandidate(f: FeatureVector): boolean {
  const { newAstrologer, uncertainty } = config.exploration;
  const impressions = f.impressions ?? 0;
  return (f.isNew !== 0 && impressions < newAstrologer.maxImpressions) || impressions < uncertainty.minImpressions;
}

/**
 * max(new-astrologer boost decaying with exposure, UCB-style uncertainty
 * bonus c·√(ln N / n)) — gives unproven astrologers a chance to be seen.
 */
export const explorationSignal: Signal = {
  name: "exploration",
  audience: "user",
  compute({ features: f }, { totalImpressions }) {
    const { enabled, newAstrologer, uncertainty } = config.exploration;
    if (!enabled) return { value: 0 };

    const n = f.impressions ?? 0;
    const newBoost =
      f.isNew !== 0 && n < newAstrologer.maxImpressions
        ? newAstrologer.initialBoost * (1 - n / newAstrologer.maxImpressions)
        : 0;
    const ucb = n < uncertainty.minImpressions
      ? clamp(uncertainty.coefficient * Math.sqrt(Math.log(totalImpressions + 2) / (n + 1)))
      : 0;
    const value = clamp(Math.max(newBoost, ucb));
    return {
      value,
      reason: f.isNew === 1 ? "New on the platform" : undefined,
      detail: { impressions: n, newBoost, ucb },
    };
  },
};

/** Priority multiplier for qualified candidates of under-target providers (1 = none). */
function providerPriority(c: RankedCandidate, sctx: SignalContext): number {
  const w = config.exploration.providerPriorityWeight;
  const gap = sctx.providers.get(c.astrologer.providerId)?.gap ?? 0;
  if (w === 0 || gap <= 0 || !isBalanceQualified(c, sctx)) return 1;
  return 1 + w * clamp(gap / config.ranking.adjustments.providerBooster.saturationGap);
}

function explorationSeed(sctx: SignalContext): string {
  if (!config.exploration.seedBySession) return String(Math.random());
  const day = new Date(sctx.now).toISOString().slice(0, 10);
  // The visitor id first, so every tab (and the admin dashboard for that visitor) sees the same picks.
  return sctx.ctx.user.userId ?? sctx.ctx.user.sessionId ?? `anon:${day}`;
}

/**
 * Reserves config.exploration.slotShare of the visible positions for
 * exploration candidates ranked below them, spread evenly across
 * slotPositions. Picks are seeded per session so results are stable.
 * Qualified candidates (provider quality/relevance gates, not offline) from
 * under-target providers get priority × (1 + providerPriorityWeight × gap
 * saturation), so every provider's new astrologers get seen over time.
 */
export function placeExploration(order: RankedCandidate[], sctx: SignalContext): RankedCandidate[] {
  const { enabled, slotShare, slotPositions } = config.exploration;
  if (!enabled || order.length <= slotPositions.min) return order;

  const lastSlot = Math.min(slotPositions.max, order.length);
  const k = Math.round(slotShare * lastSlot);
  if (k === 0) return order;

  const seed = explorationSeed(sctx);
  const pool = order
    .slice(lastSlot)
    .filter((c) => isExplorationCandidate(c.features))
    .map((c) => ({ c, priority: c.score * (0.5 + hashUnit(`${seed}:${c.astrologer.id}`)) * providerPriority(c, sctx) }))
    .sort((a, b) => b.priority - a.priority)
    .map((p) => p.c);

  // Target slots, evenly spread across the exploration range.
  const span = lastSlot - slotPositions.min;
  const positions = Array.from({ length: k }, (_, i) => slotPositions.min + Math.round(((i + 1) * span) / (k + 1)));

  // Placements must not break the rules diversify() enforced: the top-N
  // premium cap and the consecutive-same-provider limit.
  const { topN, maxPremiumShareTopN } = config.business.guardrails;
  const premiumCap = Math.ceil(maxPremiumShareTopN * topN);
  const maxRun = config.exploration.diversity.maxConsecutiveSameProvider;
  let premiumInTopN = order.slice(0, topN).filter((c) => c.features.priceBand === 2).length;
  const out = [...order];

  const runIfInserted = (c: RankedCandidate, at: number) => {
    const pid = c.astrologer.providerId;
    let run = 1;
    for (let i = at - 1; i >= 0 && out[i].astrologer.providerId === pid; i--) run++;
    for (let i = at; i < out.length && out[i].astrologer.providerId === pid; i++) run++;
    return run;
  };

  for (const position of positions) {
    const at = position - 1;
    const inTopN = position <= topN;
    const idx = pool.findIndex(
      (c) =>
        !(inTopN && c.features.priceBand === 2 && premiumInTopN >= premiumCap) &&
        (!config.exploration.diversity.enabled || runIfInserted(c, at) <= maxRun),
    );
    if (idx < 0) continue;
    const [c] = pool.splice(idx, 1);
    if (inTopN && c.features.priceBand === 2) premiumInTopN++;
    out.splice(out.indexOf(c), 1); // from below lastSlot, so earlier positions don't shift
    out.splice(at, 0, {
      ...c,
      isExploration: true,
      adjustments: [...c.adjustments, { stage: "exploration", note: `placed in exploration slot #${position}` }],
    });
  }
  return out;
}
