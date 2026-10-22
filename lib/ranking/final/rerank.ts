import { config } from "@/config";
import { checkEligibility } from "@/lib/astrologer";
import type { AstrologerMetrics } from "@/types/analytics";
import type { RankedCandidate, SignalContext } from "../types";

/*
 * Layer 6 — last checks before a list is served. Each step only removes or
 * repairs; a list that already satisfies everything comes out unchanged.
 *
 *   1. revalidate   eligibility (incl. availability / online-only) again on
 *                   the profile being served, so no later layer can surface
 *                   an ineligible astrologer
 *   2. dedupe       one entry per astrologer id (first, i.e. best, kept)
 *   3. safe order   candidates with a non-finite score go to the end
 *   4. constraints  top-N provider share cap, top-N premium cap and the
 *                   consecutive-same-provider rule: when the next candidate
 *                   would break one, the first later candidate that doesn't
 *                   is moved up (stable greedy repair). With no such
 *                   candidate the rule is relaxed. The user's favourites /
 *                   previous astrologers (exemptPersonal) and reserved-slot
 *                   holders (premium 1–2, Thompson 3–4) are never moved.
 *   5. renumber     ranks 1..n
 */

export interface FinalDrop {
  candidate: RankedCandidate;
  reasons: string[];
}

export interface FinalResult {
  ranked: RankedCandidate[];
  dropped: FinalDrop[];
  /** Candidates moved to satisfy a constraint. */
  repaired: number;
  /** Rules that couldn't be satisfied (no alternative), with how often. */
  relaxed: Record<string, number>;
}

const isPersonal = (c: RankedCandidate) => c.features.isFavorite === 1 || (c.features.userCallsWithAstrologer ?? 0) > 0;
const isPremium = (c: RankedCandidate) => c.features.priceBand === 2;

export function finalRerank(
  order: readonly RankedCandidate[],
  sctx: SignalContext,
  metrics: ReadonlyMap<string, AstrologerMetrics> = new Map(),
): FinalResult {
  const cfg = config.ranking.finalRerank;
  const dropped: FinalDrop[] = [];

  // 1–2. Revalidate and dedupe.
  const seen = new Set<string>();
  const valid: RankedCandidate[] = [];
  for (const c of order) {
    if (cfg.dedupe && seen.has(c.astrologer.id)) {
      dropped.push({ candidate: c, reasons: ["duplicate"] });
      continue;
    }
    seen.add(c.astrologer.id);
    if (cfg.revalidate) {
      const r = checkEligibility(c.astrologer, { ctx: sctx.ctx, metrics: metrics.get(c.astrologer.id), now: sctx.now });
      if (!r.eligible) {
        dropped.push({ candidate: c, reasons: r.reasons });
        continue;
      }
    }
    valid.push(c);
  }

  // 3. Non-finite scores can't be ordered meaningfully: keep them, last.
  const finite = valid.filter((c) => Number.isFinite(c.score));
  const broken = valid.filter((c) => !Number.isFinite(c.score)).map((c) => ({ ...c, adjustments: [...c.adjustments, { stage: "final" as const, note: "moved to the end: invalid score" }] }));

  // 4. Constraint repair.
  const relaxed: Record<string, number> = {};
  let repaired = 0;
  let out: RankedCandidate[] = finite;
  if (cfg.enforceConstraints) {
    const { topN, maxPremiumShareTopN } = config.business.guardrails;
    const premiumCap = Math.ceil(maxPremiumShareTopN * topN);
    const providerCap = new Map(config.providers.providers.map((p) => [p.id, Math.ceil(p.share.max * topN)]));
    const { enabled: diversityOn, maxConsecutiveSameProvider: maxRun } = config.exploration.diversity;

    const placed: RankedCandidate[] = [];
    const inTopN = new Map<string, number>();
    let premiumInTopN = 0;
    const violation = (c: RankedCandidate): string | null => {
      const pos = placed.length;
      const pid = c.astrologer.providerId;
      if (diversityOn && pos >= maxRun && placed.slice(-maxRun).every((x) => x.astrologer.providerId === pid)) return `more than ${maxRun} in a row from ${pid}`;
      if (pos < topN && (inTopN.get(pid) ?? 0) >= (providerCap.get(pid) ?? topN)) return `${pid} share cap in top ${topN}`;
      if (pos < topN && isPremium(c) && premiumInTopN >= premiumCap) return `premium-price cap in top ${topN}`;
      return null;
    };
    const place = (c: RankedCandidate) => {
      if (placed.length < topN) {
        inTopN.set(c.astrologer.providerId, (inTopN.get(c.astrologer.providerId) ?? 0) + 1);
        if (isPremium(c)) premiumInTopN++;
      }
      placed.push(c);
    };

    const rest = [...finite];
    while (rest.length) {
      const head = rest[0];
      const why = violation(head);
      if (!why) {
        place(rest.shift()!);
        continue;
      }
      if ((cfg.exemptPersonal && isPersonal(head)) || head.slot) {
        place(rest.shift()!); // the user's own pick, or a reserved premium/Thompson slot, keeps its place
        continue;
      }
      const idx = rest.findIndex((c, i) => i > 0 && violation(c) === null);
      if (idx < 0) {
        relaxed[why] = (relaxed[why] ?? 0) + 1;
        place(rest.shift()!);
        continue;
      }
      const [up] = rest.splice(idx, 1);
      repaired++;
      place({ ...up, adjustments: [...up.adjustments, { stage: "final", note: `moved up: ${why} for ${head.astrologer.id}` }] });
      const held = `held back: ${why}`;
      if (!head.adjustments.some((a) => a.note === held)) rest[0] = { ...head, adjustments: [...head.adjustments, { stage: "final", note: held }] };
    }
    out = placed;
  }

  // 5. Renumber.
  const ranked = [...out, ...broken].map((c, i) => ({ ...c, rank: i + 1 }));
  return { ranked, dropped, repaired, relaxed };
}
