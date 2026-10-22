import { config } from "@/config";
import type { Signal } from "../types";

const label = (kind: "categories" | "specializations", id: string) =>
  config.catalog[kind].find((c) => c.id === id)?.label ?? id;

/**
 * Primary if the requested value is the astrologer's first listed one,
 * secondary if listed at all. Null when nothing was requested or the
 * provider doesn't supply the field.
 */
function match(list: readonly string[], wanted: string) {
  const { primary, secondary, none } = config.ranking.signals.categoryMatch;
  const idx = list.indexOf(wanted);
  return idx === 0 ? { value: primary, match: "primary" } : idx > 0 ? { value: secondary, match: "secondary" } : { value: none, match: "none" };
}

export const categoryMatchSignal: Signal = {
  name: "categoryMatch",
  audience: "user",
  compute({ astrologer: a }, { ctx }) {
    const wanted = ctx.context.category;
    if (!wanted || a.dataQuality.missing.includes("categories")) return { value: null, detail: { requested: wanted ?? null } };
    const m = match(a.categories, wanted);
    const reason =
      m.match === "primary" ? `Specialises in ${label("categories", wanted)}`
      : m.match === "secondary" ? `Consults on ${label("categories", wanted)}`
      : undefined;
    return { value: m.value, reason, detail: { match: m.match } };
  },
};

export const specializationMatchSignal: Signal = {
  name: "specializationMatch",
  audience: "user",
  compute({ astrologer: a }, { ctx }) {
    const wanted = ctx.context.specialization;
    if (!wanted || a.dataQuality.missing.includes("specializations")) return { value: null, detail: { requested: wanted ?? null } };
    const m = match(a.specializations, wanted);
    return {
      value: m.value,
      reason: m.match !== "none" ? `${label("specializations", wanted)} expert` : undefined,
      detail: { match: m.match },
    };
  },
};
