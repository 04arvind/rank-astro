import { config } from "@/config";
import type { FeatureVector } from "@/lib/astrologer";
import { bayesianAverage, hyperbolic } from "@/lib/utils/normalization";
import type { Signal } from "../types";

/**
 * Impression → completed-call rate, smoothed toward the platform prior:
 * (calls + prior·k) / (impressions + k). New astrologers start at the prior.
 */
export function smoothedConversion(f: FeatureVector): number {
  const { priorRate, priorStrengthImpressions: k } = config.business.conversion;
  const calls = f.completedCalls ?? 0;
  const impressions = f.impressions ?? 0;
  return bayesianAverage(calls, impressions, priorRate, k);
}

/** Maps the smoothed rate to 0..1 with the prior at 0.5. */
export const conversionSignal: Signal = {
  name: "conversion",
  audience: "internal",
  compute({ features: f }) {
    const { priorRate } = config.business.conversion;
    const rate = smoothedConversion(f);
    return {
      value: hyperbolic(rate, priorRate),
      reason: `Converts ${(rate * 100).toFixed(1)}% (platform prior ${(priorRate * 100).toFixed(0)}%)`,
      detail: { smoothedRate: rate, observedRate: f.conversionRate, impressions: f.impressions },
    };
  },
};
