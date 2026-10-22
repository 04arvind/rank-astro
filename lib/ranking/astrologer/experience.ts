import { config } from "@/config";
import { logSaturation } from "@/lib/utils/normalization";
import type { Signal } from "../types";

/** Log-scaled so early years matter most; saturates at config.saturationYears. */
export const experienceSignal: Signal = {
  name: "experience",
  audience: "user",
  compute({ astrologer: a }) {
    const years = a.experienceYears;
    if (years === null) return { value: null, detail: { years: null } };
    return {
      value: logSaturation(years, config.ranking.signals.experience.saturationYears),
      reason: years >= 1 ? `${years}+ years of experience` : undefined,
      detail: { years },
    };
  },
};
