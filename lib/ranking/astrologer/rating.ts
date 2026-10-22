import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import { bayesianAverage, hyperbolic } from "@/lib/utils/normalization";
import type { Signal, SignalInput } from "../types";

function reviews({ astrologer: a, features: f }: SignalInput) {
  const provider = a.rating !== null ? a.reviewCount : 0;
  const observed = f.observedRatingCount ?? 0;
  const sum = (a.rating ?? 0) * provider + (f.observedRating ?? 0) * observed;
  return { count: provider + observed, sum };
}

/**
 * Bayesian-average rating: provider-reported and platform-observed reviews,
 * shrunk toward a prior so a single 5★ review doesn't beat 500 4.8★ ones.
 */
export const ratingSignal: Signal = {
  name: "rating",
  audience: "user",
  compute(input) {
    const { priorMean, priorWeight, scaleMax } = config.ranking.signals.rating;
    const { count, sum } = reviews(input);
    const bayesian = bayesianAverage(sum, count, priorMean, priorWeight);
    const raw = count > 0 ? sum / count : null;
    return {
      value: clamp(bayesian / scaleMax),
      reason: raw !== null ? `Rated ${raw.toFixed(1)}★ from ${count} review${count === 1 ? "" : "s"}` : undefined,
      detail: { bayesian, raw, reviews: count },
    };
  },
};

/** How much the rating can be trusted: reviews / (reviews + halfAt). */
export const reviewConfidenceSignal: Signal = {
  name: "reviewConfidence",
  audience: "internal",
  compute(input) {
    const { count } = reviews(input);
    return { value: hyperbolic(count, config.ranking.signals.reviewConfidence.halfAtReviews), detail: { reviews: count } };
  },
};
