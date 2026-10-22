import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import type { Signal } from "../types";

/*
 * Observed service-quality components (from lib/analytics metrics).
 * Each is null until there's data, so qualityScore renormalizes over what's known.
 */

/** Average call length vs. a full consultation — short calls suggest drop-offs. */
export const completionRateSignal: Signal = {
  name: "completionRate",
  audience: "internal",
  compute({ features: f }) {
    if (f.avgCallMinutes === null) return { value: null };
    const { targetCallMinutes } = config.ranking.signals.completion;
    return { value: clamp(f.avgCallMinutes / targetCallMinutes), detail: { avgCallMinutes: f.avgCallMinutes } };
  },
};

/** Share of call attempts the astrologer actually took. */
export const acceptanceRateSignal: Signal = {
  name: "acceptanceRate",
  audience: "internal",
  compute({ features: f }) {
    return { value: f.responseRate, detail: { responseRate: f.responseRate } };
  },
};

/** 1 − complaint rate among rated calls. */
export const complaintFreeSignal: Signal = {
  name: "complaintFree",
  audience: "internal",
  compute({ features: f }) {
    return { value: f.complaintRate === null ? null : 1 - f.complaintRate, detail: { complaintRate: f.complaintRate } };
  },
};

/** Share of completed calls from returning callers. */
export const repeatRateSignal: Signal = {
  name: "repeatRate",
  audience: "internal",
  compute({ features: f }) {
    return { value: f.repeatRate, detail: { repeatRate: f.repeatRate } };
  },
};
