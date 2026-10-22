import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import { bayesianAverage, hyperbolic } from "@/lib/utils/normalization";
import type { ExtensionExplanation, ExtensionTerm } from "@/types/ranking";
import { applyGates, type GateInput } from "./provider/gates";
import type { SignalContext, SignalInput } from "./types";

/*
 * Extra signals and penalties layered on the existing finalScore
 * (config.ranking.extension):
 *
 *   totalScore = finalScore
 *              + wConv × conversionScore + wRet × retentionScore + wQuota × quotaUrgencyScore
 *              − wLow × lowQualityPenalty − wUnavail × unavailablePenalty
 *              − w6 × overExposurePenalty
 *
 * providerBooster is already inside finalScore, so it isn't added again.
 * Every term is normalized to 0..1 before its weight, and unknown inputs
 * contribute nothing. The existing scores and adjustments are untouched.
 */

type Cfg = typeof config.ranking.extension;

const scoreOf = (g: GateInput, name: string) => g.scores.find((s) => s.name === name)?.value ?? null;

function signal(name: ExtensionTerm["name"], value: number | null, weight: number, inputs: ExtensionTerm["inputs"], note?: string): ExtensionTerm {
  const contribution = value === null ? 0 : weight * value;
  return { name, kind: "signal", value, weight, contribution, applied: contribution > 0, note, inputs };
}

function penalty(name: ExtensionTerm["name"], value: number, weight: number, inputs: ExtensionTerm["inputs"], note?: string): ExtensionTerm {
  const contribution = -weight * value;
  return { name, kind: "penalty", value, weight, contribution, applied: contribution < 0, note, inputs };
}

/**
 * Click → completed-call rate, smoothed toward priorRate so new astrologers
 * start neutral; the prior maps to 0.5.
 */
function conversionScore({ features: f }: SignalInput, cfg: Cfg): ExtensionTerm {
  const { priorRate, priorStrengthClicks } = cfg.conversion;
  const clicks = f.clicks ?? 0;
  const calls = f.completedCalls ?? 0;
  const rate = clamp(bayesianAverage(Math.min(calls, clicks), clicks, priorRate, priorStrengthClicks));
  return signal("conversionScore", hyperbolic(rate, priorRate), cfg.weights.conversionScore, { clicks, completedCalls: calls, smoothedRate: rate });
}

/** Share of calls from returning callers, smoothed toward priorRate (→ 0.5). */
function retentionScore({ features: f }: SignalInput, cfg: Cfg): ExtensionTerm {
  const { priorRate, priorStrengthCalls } = cfg.retention;
  const calls = f.completedCalls ?? 0;
  const repeats = (f.repeatRate ?? 0) * calls;
  const rate = clamp(bayesianAverage(repeats, calls, priorRate, priorStrengthCalls));
  return signal("retentionScore", hyperbolic(rate, priorRate), cfg.weights.retentionScore, { completedCalls: calls, repeatRate: f.repeatRate, smoothedRate: rate });
}

/**
 * (target − delivered so far) / target for the provider's share of this
 * quota period's top slots, or the astrologer's own quota deficit if higher.
 * Gated like the provider adjustments so it can't lift low-quality or
 * off-topic candidates.
 */
function quotaUrgencyScore({ astrologer: a }: SignalInput, sctx: SignalContext, g: GateInput, cfg: Cfg): ExtensionTerm {
  const state = sctx.providers.get(a.providerId);
  const { topNTotal, providerShare } = sctx.exposure.period;
  const delivered = providerShare.get(a.providerId) ?? 0;
  const target = state?.targetShare ?? 0;

  let providerDeficit = 0;
  let note: string | undefined;
  if (!state) note = "provider state unknown";
  else if (state.saturated) note = "provider at capacity";
  else if (topNTotal < cfg.quotaUrgency.minPeriodImpressions) note = `waiting for ${cfg.quotaUrgency.minPeriodImpressions} period impressions`;
  else if (target > 0) providerDeficit = clamp((target - delivered) / target);

  const quota = config.ranking.adjustments.quotaUrgency.astrologerQuotas[a.id];
  const shown = sctx.exposure.byAstrologer.get(a.id)?.period ?? 0;
  const astrologerDeficit = quota ? clamp((quota - shown) / quota) : 0;

  const value = Math.max(providerDeficit, astrologerDeficit);
  const weight = cfg.weights.quotaUrgencyScore;
  const gated = applyGates(weight * value, config.ranking.adjustments.quotaUrgency, g, sctx);
  return {
    name: "quotaUrgencyScore",
    kind: "signal",
    value,
    weight,
    contribution: gated.value,
    applied: gated.applied,
    note: gated.note ?? note,
    inputs: { targetShare: target, deliveredShare: delivered, providerDeficit, astrologerQuota: quota ?? null, astrologerPeriodImpressions: shown, astrologerDeficit },
  };
}

/**
 * Long-run over-exposure: the astrologer's share of impressions in the
 * metrics window vs. a fair share among candidates, 0 at startMultiple
 * rising to 1 at fullMultiple. (Short-term fatigue stays with frequencyPenalty.)
 */
function overExposurePenalty({ features: f }: SignalInput, sctx: SignalContext, cfg: Cfg): ExtensionTerm {
  const o = cfg.penalties.overExposure;
  const impressions = f.impressions ?? 0;
  const inputs = { impressions, totalImpressions: sctx.totalImpressions, candidates: sctx.candidateCount };
  if (o.exemptPersonal && (f.isFavorite === 1 || (f.userCallsWithAstrologer ?? 0) > 0)) {
    return penalty("overExposurePenalty", 0, o.weight, inputs, "waived (favourite/previous astrologer)");
  }
  if (sctx.totalImpressions < o.minImpressions || sctx.candidateCount === 0) {
    return penalty("overExposurePenalty", 0, o.weight, inputs, `needs ${o.minImpressions} impressions`);
  }
  const multiple = impressions / sctx.totalImpressions / (1 / sctx.candidateCount);
  const value = clamp((multiple - o.startMultiple) / (o.fullMultiple - o.startMultiple));
  return penalty("overExposurePenalty", value, o.weight, { ...inputs, shareMultiple: multiple });
}

/** Only below the threshold: (threshold − qualityScore) / threshold. */
function lowQualityPenalty(g: GateInput, cfg: Cfg): ExtensionTerm {
  const { weight, threshold } = cfg.penalties.lowQuality;
  const quality = scoreOf(g, "qualityScore");
  const value = quality !== null && threshold > 0 && quality < threshold ? clamp((threshold - quality) / threshold) : 0;
  return penalty("lowQualityPenalty", value, weight, { qualityScore: quality, threshold });
}

/** Per-status penalty from config (offline is ideally excluded by eligibility instead). */
function unavailablePenalty({ astrologer: a }: SignalInput, cfg: Cfg): ExtensionTerm {
  const { weight, byStatus } = cfg.penalties.unavailable;
  const status = a.availability.status;
  return penalty("unavailablePenalty", clamp(byStatus[status]), weight, { status });
}

/** All extension terms for one candidate, or undefined when the extension is disabled. */
export function computeExtension(input: SignalInput, sctx: SignalContext, g: GateInput): ExtensionExplanation | undefined {
  const cfg = config.ranking.extension;
  if (!cfg.enabled) return undefined;
  const terms = [
    conversionScore(input, cfg),
    retentionScore(input, cfg),
    quotaUrgencyScore(input, sctx, g, cfg),
    lowQualityPenalty(g, cfg),
    unavailablePenalty(input, cfg),
    overExposurePenalty(input, sctx, cfg),
  ];
  return { terms, total: terms.reduce((s, t) => s + t.contribution, 0) };
}
