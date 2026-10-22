import { clamp } from "@/lib/utils/math";
import type { Signal } from "../types";

/**
 * Overlap between this astrologer's categories/specializations and those of
 * astrologers the user has consulted, weighted by how often.
 */
export const categoryAffinitySignal: Signal = {
  name: "categoryAffinity",
  audience: "user",
  compute({ astrologer: a }, { user }) {
    if (user.categoryAffinity.size === 0) return { value: null, detail: { history: 0 } };

    let best = 0;
    let bestTag: string | null = null;
    for (const t of new Set([...a.categories, ...a.specializations])) {
      const s = user.categoryAffinity.get(t) ?? 0;
      if (s > best) [best, bestTag] = [s, t];
    }
    return {
      value: clamp(best),
      reason: bestTag ? "Similar to astrologers you've consulted" : undefined,
      detail: { tag: bestTag, share: best },
    };
  },
};
