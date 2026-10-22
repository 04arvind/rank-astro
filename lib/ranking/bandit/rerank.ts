import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import { hyperbolic } from "@/lib/utils/normalization";
import { relevanceOf } from "../provider/gates";
import type { RankedCandidate, SignalContext } from "../types";
import { sampleBeta, seededRandom } from "./beta";
import type { BanditContext, BanditDecision, BanditState } from "./policy";
import { expectedMarginPerConsultation, posteriorFor } from "./posterior";

/*
 * Layer 5 — Thompson sampling over the pre-bandit ranking. Scores are never
 * changed; only positions firstSlot..slots (3–4) are re-assigned. Positions
 * above firstSlot are the premium slots (business/premiumSlots.ts) and are
 * kept as they are; Thompson picks are only ever shown in firstSlot..slots:
 *
 *   1. Pool = Layer-2 positions 1..poolSize. A pooled candidate competes
 *      for a slot if it passes the quality/relevance gates, isn't offline,
 *      and (pinPersonal) isn't the user's favourite / previous astrologer.
 *      Everyone else keeps their Layer-2 position.
 *   2. Each competitor draws θ ~ Beta(posterior) — P(completed consultation
 *      | shown). The prior mean is the provider rate × (Layer-2 score /
 *      pool median)^layer2PriorExponent, so with no data Layer 2 mostly
 *      decides; the astrologer's own attributed outcomes then take over.
 *   3. Slots are filled best reward first (θ, or θ × expected margin, per
 *      config objective, × a fair-exposure lift for under-target providers'
 *      astrologers — bandit.fairness), keeping the provider share cap in the top N and
 *      the max-consecutive-same-provider rule. Below the slots, Layer-2
 *      order resumes.
 *
 * A rarely shown astrologer has a wide posterior, so some draws land high
 * and it wins a top slot now and then — that is how #40 gets seen and
 * learned, while a proven astrologer's narrow posterior keeps it near its
 * true rate. Shadow mode and holdout viewers get the Layer-2 order back
 * (samples are still drawn and logged).
 */

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const isPersonal = (c: RankedCandidate) => c.features.isFavorite === 1 || (c.features.userCallsWithAstrologer ?? 0) > 0;

/** May this candidate be moved into a Thompson slot? */
function competes(c: RankedCandidate, sctx: SignalContext): boolean {
  const { gates, pinPersonal } = config.ranking.bandit;
  const quality = c.explanation.scores.find((s) => s.name === "qualityScore")?.value ?? 0;
  return (
    quality >= gates.minQualityScore &&
    relevanceOf(c.explanation.scores, sctx) >= gates.minRelevance &&
    !config.exploration.diversity.providerFloor.excludeStatuses.includes(c.astrologer.availability.status) &&
    !(pinPersonal && isPersonal(c))
  );
}

export function thompsonRerank(order: RankedCandidate[], state: BanditState | undefined, sctx: SignalContext): { ranked: RankedCandidate[]; bandit?: BanditContext } {
  if (!state || order.length === 0) return { ranked: order };
  const cfg = config.ranking.bandit;
  const { arms, ...rest } = state;

  const pool = order.slice(0, cfg.poolSize);
  const competing = new Set(pool.filter((c) => competes(c, sctx)).map((c) => c.astrologer.id));
  // The learned ranker's order score when Layer 4 re-ordered the list, else the business score.
  const priorScore = (c: RankedCandidate) => c.orderScore ?? c.score;
  const mid = median(pool.filter((c) => competing.has(c.astrologer.id)).map(priorScore));
  const margins = new Map(pool.map((c) => [c.astrologer.id, expectedMarginPerConsultation(c.astrologer, c.features.avgCallMinutes ?? null)]));
  const refMargin = median([...margins.values()].filter((m) => m > 0));
  const { rate } = cfg.prior;
  const { completion: wc, profit: wp } = cfg.objective;
  const fairnessOf = (c: RankedCandidate) => {
    const gap = sctx.providers.get(c.astrologer.providerId)?.gap ?? 0;
    if (cfg.fairness.weight === 0 || gap <= 0) return 1;
    return 1 + cfg.fairness.weight * clamp(gap / config.ranking.adjustments.providerBooster.saturationGap);
  };

  // A draw for every pooled candidate (logged for learning); only competitors use it for slots.
  const decisions = new Map<string, BanditDecision>();
  pool.forEach((c, i) => {
    const s = priorScore(c);
    const layer2 = mid > 0 && s > 0 ? Math.pow(s / mid, cfg.layer2PriorExponent) : 1;
    const posterior = posteriorFor(c.astrologer, state.context, arms, state.policy, cfg, layer2);
    const sample = sampleBeta(posterior.alpha, posterior.beta, seededRandom(`${state.seed}:${c.astrologer.id}`));
    const margin = margins.get(c.astrologer.id) ?? 0;
    const completion = hyperbolic(sample, rate);
    const profit = margin > 0 && refMargin > 0 ? hyperbolic(sample * margin, rate * refMargin) : null;
    const fairness = fairnessOf(c);
    const reward = (profit === null || wc + wp === 0 ? completion : (wc * completion + wp * profit) / (wc + wp)) * fairness;
    decisions.set(c.astrologer.id, { sample, posterior, marginPerConsultation: margin, reward, fairness, layer2Rank: i + 1, rank: i + 1 });
  });

  const withLayer2 = order.map((c, i) => ({ ...c, layer2Rank: i + 1 }));
  if (state.mode !== "live" || state.variant === "control") {
    return { ranked: withLayer2, bandit: { ...rest, decisions } };
  }

  // Fill the slots.
  const slots = Math.min(cfg.slots, withLayer2.length);
  const { topN } = config.business.guardrails;
  const providerCap = new Map(config.providers.providers.map((p) => [p.id, Math.ceil(p.share.max * topN)]));
  const maxRun = config.exploration.diversity.maxConsecutiveSameProvider;
  const contenders = withLayer2
    .slice(0, cfg.poolSize)
    .filter((c) => competing.has(c.astrologer.id))
    .sort((a, b) => decisions.get(b.astrologer.id)!.reward - decisions.get(a.astrologer.id)!.reward || a.layer2Rank - b.layer2Rank);

  const out: typeof withLayer2 = [];
  const placed = new Set<string>();
  const inTopN = new Map<string, number>();
  const take = (c: (typeof withLayer2)[number]) => {
    out.push(c);
    placed.add(c.astrologer.id);
    if (out.length <= topN) inTopN.set(c.astrologer.providerId, (inTopN.get(c.astrologer.providerId) ?? 0) + 1);
  };
  const allowed = (c: (typeof withLayer2)[number]) => {
    const pid = c.astrologer.providerId;
    if (out.length < topN && (inTopN.get(pid) ?? 0) >= (providerCap.get(pid) ?? topN)) return false;
    const tail = out.slice(-maxRun);
    return !(config.exploration.diversity.enabled && tail.length === maxRun && tail.every((x) => x.astrologer.providerId === pid));
  };

  // Positions above the Thompson range (the premium slots) keep their occupants.
  const first = Math.min(Math.max(0, cfg.firstSlot - 1), slots);
  for (let pos = 0; pos < first; pos++) take(withLayer2[pos]);
  for (let pos = first; pos < slots; pos++) {
    const occupant = withLayer2[pos];
    // Non-competitors (pinned personal picks, gated or offline) keep their pre-bandit position.
    if (!placed.has(occupant.astrologer.id) && !competing.has(occupant.astrologer.id)) {
      take(occupant);
      continue;
    }
    const open = contenders.filter((c) => !placed.has(c.astrologer.id));
    const pick = open.find(allowed) ?? open[0];
    if (pick) take({ ...pick, slot: "bandit" });
  }
  for (const c of withLayer2) if (!placed.has(c.astrologer.id)) take(c);

  const ranked = out.map((c, i) => {
    const d = decisions.get(c.astrologer.id);
    const rank = i + 1;
    if (d) d.rank = rank;
    if (!d || (rank === c.layer2Rank && c.slot !== "bandit")) return c;
    const draw = `θ ${d.sample.toFixed(4)}, ${d.posterior.trials.toFixed(1)} exposures`;
    const note =
      c.slot === "bandit"
        ? rank === c.layer2Rank
          ? `Thompson slot #${rank} (kept its position; ${draw})`
          : `Thompson slot: #${c.layer2Rank} → #${rank} (${draw})`
        : rank < c.layer2Rank
          ? `moved #${c.layer2Rank} → #${rank}`
          : `moved #${c.layer2Rank} → #${rank} below Thompson picks`;
    return { ...c, adjustments: [...c.adjustments, { stage: "bandit" as const, note }] };
  });
  return { ranked, bandit: { ...rest, decisions } };
}
