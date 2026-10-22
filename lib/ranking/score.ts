import { config } from "@/config";
import type { FeatureVector } from "@/lib/astrologer";
import { logError, RankingError } from "@/lib/errors";
import { clamp } from "@/lib/utils/math";
import type { AdjustmentExplanation, RankingExplanation, ScoreExplanation } from "@/types/ranking";
import { computePillars } from "./business/pillars";
import { frequencyPenalty } from "./exploration/frequencyPenalty";
import { computeExtension } from "./extension";
import { providerBooster } from "./provider/proiverBoost";
import { quotaUrgencyBoost } from "./provider/quotaUrgency";
import { COMPONENT_SCORES, computeScore, initialDiversityScore } from "./scores";
import type { ScoredCandidate, SignalContext, SignalInput } from "./types";

/**
 * Turns candidates into scores with a full explanation. The engine only
 * depends on this interface, so the weighted-score model can later be
 * replaced by, or blended with, another scorer.
 */
export interface Scorer {
  readonly name: string;
  score(inputs: readonly SignalInput[], sctx: SignalContext): Promise<ScoredCandidate[]>;
}

const fmt = (n: number) => n.toFixed(4);

type Draft = Pick<RankingExplanation, "scores" | "adjustments" | "segment" | "model" | "extension">;

/** Computes baseScore, finalScore, totalScore, the 12-signal summary and the formula from scores + adjustments + extension. */
export function finalize(e: Draft, extra: { utilizationScore: number | null; quotaUrgencyScore: number }): RankingExplanation {
  const modelWeight = e.model?.weight ?? 0;
  const weighted = e.scores.reduce((s, x) => s + x.contribution, 0);
  const baseScore = e.model ? (1 - modelWeight) * weighted + modelWeight * e.model.prediction : weighted;
  const adj = (n: AdjustmentExplanation["name"]) => e.adjustments.find((a) => a.name === n)?.value ?? 0;
  const finalScore = baseScore + adj("providerBooster") + adj("quotaUrgencyBoost") + adj("frequencyPenalty");
  const v = (n: ScoreExplanation["name"]) => e.scores.find((s) => s.name === n)?.value ?? 0;
  const ext = e.extension;
  const term = (n: string) => ext?.terms.find((t) => t.name === n)?.contribution ?? 0;
  const totalScore = finalScore + (ext?.total ?? 0);
  const pillars = computePillars({ scores: e.scores, adjustments: e.adjustments, extension: ext, baseScore });

  return {
    pillars,
    scores: e.scores,
    adjustments: e.adjustments,
    segment: e.segment,
    model: e.model,
    baseScore,
    finalScore,
    totalScore,
    extension: ext,
    signals: {
      qualityScore: v("qualityScore"),
      personalizationScore: v("personalizationScore"),
      businessScore: v("businessScore"),
      priceScore: v("priceScore"),
      categoryScore: v("categoryScore"),
      availabilityScore: v("availabilityScore"),
      frequencyPenalty: -adj("frequencyPenalty"),
      utilizationScore: extra.utilizationScore,
      quotaUrgencyScore: extra.quotaUrgencyScore,
      explorationScore: v("explorationScore"),
      languageScore: v("languageScore"),
      diversityScore: v("diversityScore"),
    },
    formula:
      `final ${fmt(finalScore)} = base ${fmt(baseScore)}` +
      ` + providerBooster ${fmt(adj("providerBooster"))}` +
      ` + quotaUrgencyBoost ${fmt(adj("quotaUrgencyBoost"))}` +
      ` − frequencyPenalty ${fmt(-adj("frequencyPenalty"))}` +
      (e.model ? `  [base = ${1 - modelWeight}×weighted ${fmt(weighted)} + ${modelWeight}×${e.model.name} ${fmt(e.model.prediction)}]` : "") +
      (ext
        ? `  ⇒ total ${fmt(totalScore)} = final ${fmt(finalScore)}` +
          ` + conversion ${fmt(term("conversionScore"))} + retention ${fmt(term("retentionScore"))} + quotaUrgency ${fmt(term("quotaUrgencyScore"))}` +
          ` − lowQuality ${fmt(-term("lowQualityPenalty"))} − unavailable ${fmt(-term("unavailablePenalty"))}` +
          ` − w6×overExposure ${fmt(-term("overExposurePenalty"))}  (providerBooster already in final)`
        : ""),
  };
}

/** Re-finalizes an explanation after one of its scores changed (e.g. diversityScore). */
export function refinalize(e: RankingExplanation): RankingExplanation {
  return finalize(e, { utilizationScore: e.signals.utilizationScore, quotaUrgencyScore: e.signals.quotaUrgencyScore });
}

/**
 * The transparent weighted-score model:
 *   baseScore  = Σ scoreWeights[segment][s] × s        (every s normalized 0..1)
 *   finalScore = baseScore + providerBooster + quotaUrgencyBoost − frequencyPenalty
 *   totalScore = finalScore + extension signals − extension penalties (see extension.ts)
 * Boosts are bounded and gated on quality/relevance; diversityScore is
 * filled in during re-ranking (it depends on what's already placed).
 * Input candidates are already eligible — no eligibility rules here.
 */
export function createWeightedScorer(): Scorer {
  const name = `${config.ranking.engine.name}@${config.ranking.engine.version}`;
  return {
    name,
    async score(inputs, sctx) {
      const weights = config.ranking.scoreWeights[sctx.user.segment];
      return inputs.map((input) => {
        const scores = [
          ...COMPONENT_SCORES.map((s) => computeScore(s, weights[s], input, sctx)),
          initialDiversityScore(weights.diversityScore),
        ];
        const baseScore = scores.reduce((s, x) => s + x.contribution, 0);
        const gate = { scores, baseScore };
        const extension = computeExtension(input, sctx, gate);
        const { urgency, ...quota } = quotaUrgencyBoost(input, sctx, gate);
        const adjustments: AdjustmentExplanation[] = [
          providerBooster(input, sctx, gate),
          { ...quota, inputs: { ...quota.inputs, quotaUrgencyScore: urgency } },
          frequencyPenalty(input, sctx),
        ];
        const explanation = finalize(
          { scores, adjustments, segment: sctx.user.segment, extension },
          { utilizationScore: sctx.providers.get(input.astrologer.providerId)?.utilization ?? null, quotaUrgencyScore: urgency },
        );
        return { astrologer: input.astrologer, features: input.features, score: explanation.totalScore, explanation, scorer: name };
      });
    },
  };
}

/** @deprecated Alias for the previous engine's factory name. */
export const createRuleBasedScorer = createWeightedScorer;

/** A learned model predicting relevance in [0, 1]. Extension point only — no ML ships by default. */
export interface ModelScorer {
  readonly name: string;
  predict(features: readonly FeatureVector[]): Promise<number[]>;
}

/**
 * Future-model hook: baseScore becomes (1 − w) × weighted + w × prediction,
 * recorded in the explanation; adjustments still apply on top. Falls back to
 * the base scorer if the model fails.
 */
export function createBlendedScorer(base: Scorer, model: ModelScorer, modelWeight: number): Scorer {
  const w = clamp(modelWeight);
  const name = `${base.name}+${model.name}(${w})`;
  return {
    name,
    async score(inputs, sctx) {
      const [scored, predictions] = await Promise.all([
        base.score(inputs, sctx),
        model.predict(inputs.map((i) => i.features)).catch((err: unknown) => {
          logError(new RankingError("scoring", `model ${model.name} failed; using ${base.name} only`, { cause: err }), { scope: "ranking" });
          return null;
        }),
      ]);
      if (predictions === null || predictions.length !== scored.length) return scored;
      return scored.map((c, i) => {
        const explanation = refinalize({ ...c.explanation, model: { name: model.name, prediction: clamp(predictions[i] ?? 0), weight: w } });
        return { ...c, score: explanation.totalScore, explanation, scorer: name };
      });
    },
  };
}
