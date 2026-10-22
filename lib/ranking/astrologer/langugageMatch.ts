import { config } from "@/config";
import type { Signal } from "../types";

const labelOf = (id: string) => config.catalog.languages.find((l) => l.id === id)?.label ?? id;

/** Exact when the astrologer speaks every requested language, partial for some. */
export const languageMatchSignal: Signal = {
  name: "languageMatch",
  audience: "user",
  compute({ astrologer: a, features: f }, { ctx }) {
    const wanted = ctx.context.languages ?? [];
    const overlap = f.languageOverlap;
    if (wanted.length === 0 || overlap === null) return { value: null, detail: { overlap } };

    const { exact, partial, none } = config.ranking.signals.languageMatch;
    const spoken = wanted.filter((l) => a.languages.includes(l)).map(labelOf);
    if (overlap === 1) return { value: exact, reason: `Speaks ${spoken.join(" & ")}`, detail: { overlap } };
    if (overlap > 0) return { value: partial, reason: `Speaks ${spoken.join(" & ")}`, detail: { overlap } };
    return { value: none, detail: { overlap } };
  },
};
