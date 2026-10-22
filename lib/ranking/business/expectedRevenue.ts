import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import type { Signal } from "../types";
import { smoothedConversion } from "./conversion";

/**
 * Expected revenue per impression = P(call) × price/min × expected minutes,
 * relative to a "typical strong" impression (ceiling × prior conversion).
 */
export const expectedRevenueSignal: Signal = {
  name: "expectedRevenue",
  audience: "internal",
  compute({ features: f }) {
    const { revenue, conversion } = config.business;
    const minutes = f.avgCallMinutes ?? revenue.defaultCallMinutes;
    const perCall = (f.pricePerMinute ?? 0) * minutes;
    const perImpression = smoothedConversion(f) * perCall;
    return {
      value: clamp(perImpression / (revenue.normalizationCeiling * conversion.priorRate)),
      reason: `Expected ₹${perImpression.toFixed(0)}/impression (₹${perCall.toFixed(0)}/call)`,
      detail: { perCall, perImpression, minutes },
    };
  },
};

/** Expected call length (observed average, else the default) vs. the reference length. */
export const expectedDurationSignal: Signal = {
  name: "expectedDuration",
  audience: "internal",
  compute({ features: f }) {
    const { defaultCallMinutes, referenceCallMinutes } = config.business.revenue;
    const minutes = f.avgCallMinutes ?? defaultCallMinutes;
    return {
      value: clamp(minutes / referenceCallMinutes),
      detail: { expectedMinutes: minutes, source: f.avgCallMinutes === null ? "default" : "observed" },
    };
  },
};
