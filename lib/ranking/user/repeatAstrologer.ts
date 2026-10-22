import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import { halfLifeDecay } from "@/lib/utils/normalization";
import type { Signal } from "../types";

/**
 * Favourite or previously consulted astrologer: grows with call count
 * (saturating), fades with time since the last call (half-life), and
 * favourites get at least favoriteValue. Null for anonymous visitors.
 */
export const repeatAstrologerSignal: Signal = {
  name: "repeatAstrologer",
  audience: "user",
  compute({ features: f }) {
    if (f.userCallsWithAstrologer === null) return { value: null, detail: { user: "anonymous" } };

    const { favoriteValue, saturationCalls, recencyHalfLifeDays } = config.ranking.signals.repeatAstrologer;
    const favorite = f.isFavorite === 1;
    const calls = f.userCallsWithAstrologer;
    let frequency = 0;
    let recency = 0;
    if (calls > 0 && f.daysSinceUserLastCall !== null) {
      frequency = clamp(calls / saturationCalls);
      recency = halfLifeDecay(f.daysSinceUserLastCall, recencyHalfLifeDays);
    }
    const value = Math.max(frequency * recency, favorite ? favoriteValue : 0);
    const reason =
      value === 0 ? undefined
      : favorite ? "One of your favourites"
      : `You've consulted ${calls === 1 ? "once" : `${calls} times`} before`;
    return { value, reason, detail: { calls, favorite: favorite ? 1 : 0, daysSince: f.daysSinceUserLastCall, frequency, recency } };
  },
};
