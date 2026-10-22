import { config } from "@/config";
import { isBalanceQualified } from "../provider/gates";
import { refinalize } from "../score";
import type { RankedCandidate, RerankAdjustment, SignalContext } from "../types";

const primaryTag = (c: RankedCandidate) => c.astrologer.categories[0] ?? c.astrologer.specializations[0] ?? null;
const isPremium = (c: RankedCandidate) => c.features.priceBand === 2;
const diversityOf = (c: RankedCandidate) => c.explanation.scores.find((s) => s.name === "diversityScore")!;

/** Sets diversityScore on a candidate and recomputes its final score. */
function withDiversity(c: RankedCandidate, value: number, detail: Record<string, number>): RankedCandidate {
  const scores = c.explanation.scores.map((s) =>
    s.name === "diversityScore"
      ? {
          ...s,
          value,
          contribution: s.weight * value,
          components: [{ name: "novelty", value, weight: 1, contribution: s.weight * value, audience: "internal" as const, detail }],
        }
      : s,
  );
  const explanation = refinalize({ ...c.explanation, scores });
  return { ...c, explanation, score: explanation.totalScore };
}

/**
 * Greedy re-rank that fills in diversityScore. At each position:
 *   diversityScore = 1 / (1 + same-provider + same-category already in the window)
 *   candidate key  = finalScore with that diversityScore
 * and the best key wins, subject to hard rules:
 *  - no more than maxConsecutiveSameProvider in a row (whole list),
 *  - per-provider / per-category caps inside the diversity window,
 *  - provider share.max and the premium-price share inside the top N,
 *  - provider floors (share.min × topN) inside the top N: once the slots
 *    left equal the floors still owed, the slot goes to the best qualified
 *    candidate of an owed provider (quality/relevance gates, not offline,
 *    within providerFloor.maxScoreGap of the best remaining). A floor with
 *    no qualified candidate is simply not filled.
 * If nothing satisfies every rule, the rules are relaxed for that slot.
 */
export function diversify(sorted: readonly RankedCandidate[], sctx?: SignalContext): RankedCandidate[] {
  const d = config.exploration.diversity;
  const topN = config.business.guardrails.topN;
  const premiumCap = Math.ceil(config.business.guardrails.maxPremiumShareTopN * topN);
  const providerCap = new Map(config.providers.providers.map((p) => [p.id, Math.ceil(p.share.max * topN)]));
  const floorCfg = d.providerFloor;
  const providerFloor = new Map(
    config.providers.providers.filter((p) => p.enabled).map((p) => [p.id, Math.floor(p.share.min * topN)]),
  );
  const qualified = new Map<string, boolean>();
  const isQualified = (c: RankedCandidate) => {
    let q = qualified.get(c.astrologer.id);
    if (q === undefined) qualified.set(c.astrologer.id, (q = sctx ? isBalanceQualified(c, sctx) : false));
    return q;
  };

  const remaining = [...sorted];
  const out: RankedCandidate[] = [];
  const providerInWindow = new Map<string, number>();
  const tagInWindow = new Map<string, number>();
  const providerInTopN = new Map<string, number>();
  let premiumInTopN = 0;

  const blockedBy = (c: RankedCandidate, pos: number): RerankAdjustment | null => {
    const diversity = (why: string): RerankAdjustment => ({ stage: "diversity", note: `held back: ${why}` });
    const guardrail = (why: string): RerankAdjustment => ({ stage: "guardrail", note: `held back: ${why}` });
    const pid = c.astrologer.providerId;
    const tail = out.slice(-d.maxConsecutiveSameProvider);
    if (d.enabled && tail.length === d.maxConsecutiveSameProvider && tail.every((x) => x.astrologer.providerId === pid)) {
      return diversity(`more than ${d.maxConsecutiveSameProvider} in a row from ${pid}`);
    }
    if (d.enabled && pos < d.windowSize) {
      if ((providerInWindow.get(pid) ?? 0) >= d.maxPerProviderInWindow) return diversity(`${pid} cap in top ${d.windowSize}`);
      const tag = primaryTag(c);
      if (tag && (tagInWindow.get(tag) ?? 0) >= d.maxPerCategoryInWindow) return diversity(`"${tag}" cap in top ${d.windowSize}`);
    }
    if (pos < topN) {
      if ((providerInTopN.get(pid) ?? 0) >= (providerCap.get(pid) ?? topN)) return guardrail(`${pid} share cap in top ${topN}`);
      if (isPremium(c) && premiumInTopN >= premiumCap) return guardrail(`premium-price cap in top ${topN}`);
    }
    return null;
  };

  const noveltyAt = (c: RankedCandidate, pos: number) => {
    if (!d.enabled || pos >= d.windowSize) return { value: 1, providerRepeats: 0, categoryRepeats: 0 };
    const tag = primaryTag(c);
    const providerRepeats = providerInWindow.get(c.astrologer.providerId) ?? 0;
    const categoryRepeats = tag ? (tagInWindow.get(tag) ?? 0) : 0;
    return { value: 1 / (1 + providerRepeats + categoryRepeats), providerRepeats, categoryRepeats };
  };

  const keyAt = (c: RankedCandidate, novelty: number) => {
    const div = diversityOf(c);
    return c.score - div.contribution + div.weight * novelty;
  };

  const notes = new Map<string, RerankAdjustment[]>();
  const note = (c: RankedCandidate, a: RerankAdjustment) => notes.set(c.astrologer.id, [...(notes.get(c.astrologer.id) ?? []), a]);

  /** Providers still owed floor slots that have a qualified candidate close enough to the best. */
  const owedProviders = (pos: number): Set<string> | null => {
    if (!sctx || !floorCfg.enabled || pos >= topN) return null;
    const best = Math.max(...remaining.map((c) => c.score));
    const owed = new Set<string>();
    let need = 0;
    for (const [pid, floor] of providerFloor) {
      const missing = floor - (providerInTopN.get(pid) ?? 0);
      if (missing <= 0) continue;
      if (remaining.some((c) => c.astrologer.providerId === pid && isQualified(c) && best - c.score <= floorCfg.maxScoreGap)) {
        owed.add(pid);
        need += missing;
      }
    }
    return owed.size > 0 && need >= topN - pos ? owed : null;
  };

  const pickBest = (pos: number, allow?: (c: RankedCandidate) => boolean) => {
    let bestIdx = -1;
    let bestKey = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      if (allow && !allow(c)) continue;
      const block = blockedBy(c, pos);
      if (block) {
        if (i === 0 && !allow) note(c, block); // only when it costs the top-scoring candidate this slot
        continue;
      }
      const k = keyAt(c, noveltyAt(c, pos).value);
      if (k > bestKey) [bestIdx, bestKey] = [i, k];
    }
    return bestIdx;
  };

  for (let pos = 0; remaining.length > 0; pos++) {
    const owed = owedProviders(pos);
    let bestIdx = -1;
    if (owed) {
      const best = Math.max(...remaining.map((c) => c.score));
      bestIdx = pickBest(pos, (c) => owed.has(c.astrologer.providerId) && isQualified(c) && best - c.score <= floorCfg.maxScoreGap);
      if (bestIdx > 0) {
        note(remaining[bestIdx], { stage: "guardrail", note: `promoted: ${remaining[bestIdx].astrologer.providerId} exposure floor in top ${topN}` });
      }
    }
    const byFloor = bestIdx !== -1;
    if (!byFloor) bestIdx = pickBest(pos);

    if (byFloor) {
      // Floor promotion already noted.
    } else if (bestIdx === -1) {
      bestIdx = 0;
      note(remaining[0], { stage: "diversity", note: "diversity rules relaxed (no alternative)" });
    } else if (bestIdx !== 0) {
      note(remaining[bestIdx], { stage: "diversity", note: `promoted for variety over ${remaining[0].astrologer.id}` });
    }

    const [chosen] = remaining.splice(bestIdx, 1);
    const n = noveltyAt(chosen, pos);
    const picked = withDiversity(chosen, n.value, { position: pos + 1, providerRepeats: n.providerRepeats, categoryRepeats: n.categoryRepeats });

    const pid = picked.astrologer.providerId;
    if (pos < d.windowSize) {
      providerInWindow.set(pid, (providerInWindow.get(pid) ?? 0) + 1);
      const tag = primaryTag(picked);
      if (tag) tagInWindow.set(tag, (tagInWindow.get(tag) ?? 0) + 1);
    }
    if (pos < topN) {
      providerInTopN.set(pid, (providerInTopN.get(pid) ?? 0) + 1);
      if (isPremium(picked)) premiumInTopN++;
    }
    out.push(picked);
  }

  return out.map((c) => {
    const extra = notes.get(c.astrologer.id);
    if (!extra) return c;
    const seen = new Set<string>();
    return { ...c, adjustments: [...c.adjustments, ...extra.filter((a) => !seen.has(a.note) && seen.add(a.note))] };
  });
}
