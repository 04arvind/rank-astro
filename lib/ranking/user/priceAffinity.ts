import { config } from "@/config";
import { expDecay } from "@/lib/utils/normalization";
import type { Signal } from "../types";

/**
 * Fee vs. the user's preferred price. Preference comes from lib/user (explicit
 * range, else what they usually pay); failing that, the request's price range.
 * Full value within ±tolerance of the preferred price, then exponential decay.
 * Null when there's no preference at all.
 */
export const priceAffinitySignal: Signal = {
  name: "priceAffinity",
  audience: "user",
  compute({ features: f }, { ctx }) {
    const { tolerance } = config.ranking.signals.priceAffinity;
    const price = f.pricePerMinute ?? 0;

    let preferred = f.userTypicalPricePerMinute;
    let source = "user";
    if (preferred === null) {
      const r = ctx.context.priceRange;
      if (r && (r.min !== undefined || r.max !== undefined)) {
        preferred = r.min !== undefined && r.max !== undefined ? (r.min + r.max) / 2 : (r.max ?? r.min)!;
        source = "request";
      }
    }
    if (preferred === null || preferred <= 0) return { value: null, detail: { preferred: null } };

    const off = Math.abs(price - preferred) / preferred;
    return {
      value: expDecay(off - tolerance, tolerance),
      reason: off <= tolerance && source === "user" ? "In your usual price range" : undefined,
      detail: { price, preferred, deviation: off, source },
    };
  },
};
