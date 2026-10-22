import { config } from "@/config";
import type { AstrologerProfile } from "@/types/astrologer";

type Profile = Pick<AstrologerProfile, "categories" | "specializations" | "languages" | "pricing">;

function jaccard(a: readonly string[], b: readonly string[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  const sa = new Set(a);
  const inter = b.filter((x) => sa.has(x)).length;
  return inter / new Set([...a, ...b]).size;
}

/** 1 at equal price, 0 at a 4× difference or more. */
function priceCloseness(a: number, b: number): number | null {
  if (a <= 0 || b <= 0) return null;
  return Math.max(0, 1 - Math.abs(Math.log(a / b)) / Math.log(4));
}

/**
 * How alike two astrologers are (0..1): weighted mean of topic overlap,
 * language overlap and price closeness over the dimensions both profiles
 * supply. Null unless at least topics or languages are comparable — price
 * alone doesn't make two astrologers "similar".
 */
export function similarity(a: Profile, b: Profile): number | null {
  const w = config.feed.personalized.similarityWeights;
  const tags = jaccard([...a.categories, ...a.specializations], [...b.categories, ...b.specializations]);
  const languages = jaccard(a.languages, b.languages);
  if (tags === null && languages === null) return null;
  const parts: [number | null, number][] = [
    [tags, w.tags],
    [languages, w.languages],
    [priceCloseness(a.pricing.perMinute, b.pricing.perMinute), w.price],
  ];
  const known = parts.filter((p): p is [number, number] => p[0] !== null);
  const weight = known.reduce((s, [, wt]) => s + wt, 0);
  return weight > 0 ? known.reduce((s, [v, wt]) => s + v * wt, 0) / weight : null;
}
