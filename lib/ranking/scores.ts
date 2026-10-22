import { config, type ScoreName, type SignalName } from "@/config";
import { clamp } from "@/lib/utils/math";
import type { ComponentExplanation, ScoreExplanation } from "@/types/ranking";
import { SIGNAL_REGISTRY } from "./signals";
import type { SignalContext, SignalInput } from "./types";

/*
 * Composite scores: each is a weighted mean of normalized components. Weights
 * come from config.ranking.components (single-component scores use weight 1).
 * Unknown components (null) are left out and the remaining weights
 * renormalized; if nothing is known the score takes config.neutralValue.
 */

type ComponentScore = Exclude<ScoreName, "diversityScore">;

/** Which components make up each composite score. */
const SINGLE: Partial<Record<ComponentScore, SignalName>> = {
  priceScore: "priceAffinity",
  explorationScore: "exploration",
  languageScore: "languageMatch",
};

function componentWeights(score: ComponentScore): [SignalName, number][] {
  const single = SINGLE[score];
  if (single) return [[single, 1]];
  const weights = config.ranking.components[score as keyof typeof config.ranking.components];
  return Object.entries(weights) as [SignalName, number][];
}

export const COMPONENT_SCORES: readonly ComponentScore[] = [
  "qualityScore",
  "personalizationScore",
  "businessScore",
  "priceScore",
  "categoryScore",
  "availabilityScore",
  "explorationScore",
  "languageScore",
];

export function computeScore(
  score: ComponentScore,
  scoreWeight: number,
  input: SignalInput,
  sctx: SignalContext,
): ScoreExplanation {
  const parts = componentWeights(score).map(([name, weight]) => {
    const signal = SIGNAL_REGISTRY[name];
    const r = signal.compute(input, sctx);
    const value = r.value === null || Number.isNaN(r.value) ? null : clamp(r.value);
    return { name, weight, value, audience: signal.audience, reason: r.reason, detail: r.detail };
  });

  const known = parts.filter((p) => p.value !== null && p.weight > 0);
  const knownWeight = known.reduce((s, p) => s + p.weight, 0);
  const missing = knownWeight === 0;
  const value = missing ? config.ranking.neutralValue : known.reduce((s, p) => s + p.weight * p.value!, 0) / knownWeight;

  const components: ComponentExplanation[] = parts.map((p) => ({
    ...p,
    contribution: missing || p.value === null ? 0 : scoreWeight * (p.weight / knownWeight) * p.value,
  }));

  return { name: score, value, weight: scoreWeight, contribution: scoreWeight * value, missing, components };
}

/** Placeholder until re-ranking places the candidate; 1 = fully novel. */
export function initialDiversityScore(weight: number): ScoreExplanation {
  return { name: "diversityScore", value: 1, weight, contribution: weight, missing: false, components: [] };
}
