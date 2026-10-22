import type { ScoreName } from "@/config";
import type { BusinessPillarName, BusinessPillars, RankingExplanation } from "@/types/ranking";

/*
 * Layer 2 — business ranking, regrouped. The weighted scorer already reads
 * every business factor; this maps each score, component, adjustment and
 * extension term onto the pillar it serves so the admin view can show why
 * an astrologer ranks where they do in business terms:
 *
 *   bookingProbability  conversion, expected duration, click→call, retention
 *   profit              expected revenue per impression, contribution margin
 *   quality             qualityScore − lowQualityPenalty
 *   personalization     personal history, price, category and language fit
 *   availability        availabilityScore − unavailablePenalty
 *   utilization         provider spare capacity + provider booster/dampener
 *   exposureFairness    exploration, diversity, quota urgency, fatigue and over-exposure
 *   model               a blended model scorer's share of baseScore (0 by default)
 *
 * Contributions sum to totalScore exactly; nothing here changes a score.
 */

type Draft = Pick<RankingExplanation, "scores" | "adjustments" | "extension" | "baseScore">;

const PILLARS: readonly BusinessPillarName[] = [
  "bookingProbability",
  "profit",
  "quality",
  "personalization",
  "availability",
  "utilization",
  "exposureFairness",
  "model",
];

const SCORE_PILLAR: Record<ScoreName, BusinessPillarName> = {
  qualityScore: "quality",
  personalizationScore: "personalization",
  businessScore: "profit",
  priceScore: "personalization",
  categoryScore: "personalization",
  availabilityScore: "availability",
  explorationScore: "exposureFairness",
  languageScore: "personalization",
  diversityScore: "exposureFairness",
};

/** Components that belong to a different pillar than their composite score. */
const COMPONENT_PILLAR: Partial<Record<string, BusinessPillarName>> = {
  conversion: "bookingProbability",
  expectedDuration: "bookingProbability",
  expectedRevenue: "profit",
  contributionMargin: "profit",
  providerCapacity: "utilization",
};

const ADJUSTMENT_PILLAR: Record<string, BusinessPillarName> = {
  providerBooster: "utilization",
  quotaUrgencyBoost: "exposureFairness",
  frequencyPenalty: "exposureFairness",
};

const EXTENSION_PILLAR: Record<string, BusinessPillarName> = {
  conversionScore: "bookingProbability",
  retentionScore: "bookingProbability",
  quotaUrgencyScore: "exposureFairness",
  overExposurePenalty: "exposureFairness",
  lowQualityPenalty: "quality",
  unavailablePenalty: "availability",
};

const mean = (xs: (number | null | undefined)[]) => {
  const known = xs.filter((x): x is number => x !== null && x !== undefined);
  return known.length ? known.reduce((s, x) => s + x, 0) / known.length : null;
};

export function computePillars(e: Draft): BusinessPillars {
  const out = Object.fromEntries(PILLARS.map((p) => [p, { contribution: 0, value: null, sources: [] as string[] }])) as BusinessPillars;
  const add = (pillar: BusinessPillarName, source: string, contribution: number) => {
    if (!Number.isFinite(contribution) || contribution === 0) return;
    out[pillar].contribution += contribution;
    if (!out[pillar].sources.includes(source)) out[pillar].sources.push(source);
  };

  let weighted = 0;
  for (const s of e.scores) {
    weighted += s.contribution;
    const own = SCORE_PILLAR[s.name];
    if (s.missing) {
      // Neutral value with no data: split by configured component weights.
      const total = s.components.reduce((t, c) => t + c.weight, 0);
      if (total > 0) for (const c of s.components) add(COMPONENT_PILLAR[c.name] ?? own, c.name, (s.contribution * c.weight) / total);
      else add(own, s.name, s.contribution);
      continue;
    }
    let attributed = 0;
    for (const c of s.components) {
      add(COMPONENT_PILLAR[c.name] ?? own, c.name, c.contribution);
      attributed += c.contribution;
    }
    // Scores without components (e.g. the diversity placeholder) or rounding residue.
    add(own, s.name, s.contribution - attributed);
  }
  add("model", "model", e.baseScore - weighted);
  for (const a of e.adjustments) add(ADJUSTMENT_PILLAR[a.name] ?? "exposureFairness", a.name, a.value);
  for (const t of e.extension?.terms ?? []) add(EXTENSION_PILLAR[t.name] ?? "exposureFairness", t.name, t.contribution);

  const score = (n: ScoreName) => e.scores.find((s) => s.name === n)?.value ?? null;
  const component = (n: string) => e.scores.flatMap((s) => s.components).find((c) => c.name === n)?.value ?? null;
  out.bookingProbability.value = component("conversion");
  out.profit.value = mean([component("expectedRevenue"), component("contributionMargin")]);
  out.quality.value = score("qualityScore");
  out.personalization.value = score("personalizationScore");
  out.availability.value = score("availabilityScore");
  out.utilization.value = component("providerCapacity");
  return out;
}
