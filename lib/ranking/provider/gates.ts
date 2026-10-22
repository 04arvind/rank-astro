import { config } from "@/config";
import type { AstrologerProfile } from "@/types/astrologer";
import type { ScoreExplanation } from "@/types/ranking";
import type { SignalContext } from "../types";

export interface GateConfig {
  minQualityScore: number;
  minRelevance: number;
  maxRelativeToBase: number;
}

export interface GateInput {
  scores: readonly ScoreExplanation[];
  baseScore: number;
}

const scoreOf = (scores: readonly ScoreExplanation[], name: ScoreExplanation["name"]) =>
  scores.find((s) => s.name === name)?.value ?? null;

/**
 * Relevance to the request: the lower of languageScore and categoryScore
 * among the dimensions the request actually asked about. 1 when neither was asked.
 */
export function relevanceOf(scores: readonly ScoreExplanation[], sctx: SignalContext): number {
  const { languages, category, specialization } = sctx.ctx.context;
  const asked: number[] = [];
  if (languages?.length) asked.push(scoreOf(scores, "languageScore") ?? 1);
  if (category || specialization) asked.push(scoreOf(scores, "categoryScore") ?? 1);
  return asked.length ? Math.min(...asked) : 1;
}

/**
 * Whether a candidate may be moved up for provider balance (floor slots,
 * provider-weighted exploration): passes the provider booster's quality
 * and relevance gates and isn't in an excluded availability status.
 * Balancing never promotes anyone who fails this.
 */
export function isBalanceQualified(
  c: { astrologer: AstrologerProfile; explanation: { scores: readonly ScoreExplanation[] } },
  sctx: SignalContext,
): boolean {
  const { minQualityScore, minRelevance } = config.ranking.adjustments.providerBooster;
  const quality = scoreOf(c.explanation.scores, "qualityScore") ?? 0;
  return (
    quality >= minQualityScore &&
    relevanceOf(c.explanation.scores, sctx) >= minRelevance &&
    !config.exploration.diversity.providerFloor.excludeStatuses.includes(c.astrologer.availability.status)
  );
}

/**
 * Keeps marketplace optimization from overriding relevance or quality:
 * an adjustment is withheld for low-quality or off-topic candidates, and
 * capped at a fraction of the candidate's own baseScore.
 */
export function applyGates(
  value: number,
  gates: GateConfig,
  { scores, baseScore }: GateInput,
  sctx: SignalContext,
): { value: number; applied: boolean; note?: string; relevance: number; quality: number } {
  const quality = scoreOf(scores, "qualityScore") ?? 0;
  const relevance = relevanceOf(scores, sctx);
  if (value <= 0) return { value: 0, applied: false, relevance, quality };
  if (quality < gates.minQualityScore) {
    return { value: 0, applied: false, note: `withheld: qualityScore ${quality.toFixed(2)} < ${gates.minQualityScore}`, relevance, quality };
  }
  if (relevance < gates.minRelevance) {
    return { value: 0, applied: false, note: `withheld: relevance ${relevance.toFixed(2)} < ${gates.minRelevance}`, relevance, quality };
  }
  const cap = gates.maxRelativeToBase * baseScore;
  if (value > cap) return { value: cap, applied: true, note: `capped at ${(gates.maxRelativeToBase * 100).toFixed(0)}% of baseScore`, relevance, quality };
  return { value, applied: true, relevance, quality };
}
