import { FEATURE_NAMES } from "@/lib/astrologer";
import { hashUnit } from "@/lib/utils/math";
import type { ScoreName } from "@/config";
import type { ScoredCandidate } from "../types";

/*
 * The learned ranker's input row: the raw feature vector (lib/astrologer)
 * plus the Layer-2 composite scores and total. Served position is
 * deliberately not a feature — the model must not learn position bias.
 * Names are what scripts/ml/train_ranker.py writes into the model, and a
 * model is matched to rows by name, so adding a feature here doesn't break
 * an older model (it just ignores the new column).
 */

const SCORE_FEATURES: readonly ScoreName[] = [
  "qualityScore",
  "personalizationScore",
  "businessScore",
  "priceScore",
  "categoryScore",
  "availabilityScore",
  "explorationScore",
  "languageScore",
  "diversityScore",
];

export const ML_FEATURE_NAMES: readonly string[] = [...FEATURE_NAMES, ...SCORE_FEATURES.map((s) => `s_${s}`), "l2_totalScore"];

/** Short id of the feature list; training samples carry it so an export never mixes layouts. */
export const ML_FEATURE_VERSION = `f${ML_FEATURE_NAMES.length}-${Math.floor(hashUnit(ML_FEATURE_NAMES.join(",")) * 0xffffffff).toString(36)}`;

export type FeatureRow = (number | null)[];

/** One row in ML_FEATURE_NAMES order; null = missing (XGBoost's default branch). */
export function featureRow(c: Pick<ScoredCandidate, "features" | "explanation" | "score">): FeatureRow {
  const scores = new Map(c.explanation.scores.map((s) => [s.name, s.missing ? null : s.value]));
  const finite = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : v);
  return [
    ...FEATURE_NAMES.map((n) => finite(c.features[n])),
    ...SCORE_FEATURES.map((s) => finite(scores.get(s))),
    finite(c.explanation.totalScore),
  ];
}
