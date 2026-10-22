import { config } from "@/config";
import { minMax } from "@/lib/utils/normalization";
import type { Signal } from "../types";

/**
 * Platform margin per minute. Uses the astrologer's own payout when the
 * provider shares it, else the provider's configured revenue share.
 * Below minMarginRate earns nothing; saturates at targetMarginRate.
 */
export const contributionMarginSignal: Signal = {
  name: "contributionMargin",
  audience: "internal",
  compute({ astrologer: a, features: f }) {
    const { minMarginRate, targetMarginRate } = config.business.margin;
    const providerShare = config.providers.providers.find((p) => p.id === a.providerId)?.revenueShare ?? null;
    const margin = f.marginRate ?? providerShare;
    if (margin === null) return { value: null, detail: { margin: null } };
    return {
      value: minMax(margin, minMarginRate, targetMarginRate),
      reason: `Margin ${(margin * 100).toFixed(0)}% (${f.marginRate !== null ? "astrologer payout" : "provider share"})`,
      detail: { margin, source: f.marginRate !== null ? "payout" : "provider" },
    };
  },
};
