import type { AstrologerProfile } from "@/types/astrologer";
import { listEligibleAstrologers } from "./offers";

/*
 * Real numbers for the landing page: platform stats and, per service, how
 * many eligible astrologers offer it and the lowest per-minute price.
 */

export type ServiceId = "vedic" | "love" | "career" | "marriage" | "numerology" | "palmistry";

/** Which astrologers count toward each service (catalog category / specialization ids). */
const SERVICE_MATCH: Record<ServiceId, (a: AstrologerProfile) => boolean> = {
  vedic: (a) => a.specializations.includes("vedic") || a.specializations.includes("kp"),
  love: (a) => a.categories.includes("love"),
  career: (a) => a.categories.includes("career") || a.categories.includes("finance"),
  marriage: (a) => a.categories.includes("marriage"),
  numerology: (a) => a.specializations.includes("numerology"),
  palmistry: (a) => a.specializations.includes("palmistry"),
};

export const SERVICE_IDS = Object.keys(SERVICE_MATCH) as ServiceId[];

export interface ServiceHighlight {
  id: ServiceId;
  experts: number;
  fromPerMinute: number | null;
}

export interface HomeHighlights {
  verifiedAstrologers: number;
  /** Eligible astrologers whose live status is online. */
  onlineNow: number;
  /** Distinct catalog languages spoken. */
  languages: string[];
  /** Mean rating over rated astrologers, or null if none are rated. */
  averageRating: number | null;
  fromPerMinute: number | null;
  services: ServiceHighlight[];
}

const minPrice = (list: readonly AstrologerProfile[]) =>
  list.length ? Math.min(...list.map((a) => a.pricing.perMinute)) : null;

export async function getHomeHighlights(now = Date.now()): Promise<HomeHighlights> {
  const eligible = await listEligibleAstrologers(now);
  const rated = eligible.filter((a) => a.rating !== null);
  return {
    verifiedAstrologers: eligible.length,
    onlineNow: eligible.filter((a) => a.availability.status === "online").length,
    languages: [...new Set(eligible.flatMap((a) => a.languages))],
    averageRating: rated.length ? rated.reduce((s, a) => s + a.rating!, 0) / rated.length : null,
    fromPerMinute: minPrice(eligible),
    services: SERVICE_IDS.map((id) => {
      const matches = eligible.filter(SERVICE_MATCH[id]);
      return { id, experts: matches.length, fromPerMinute: minPrice(matches) };
    }),
  };
}
