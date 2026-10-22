import { checkEligibility, getAstrologerRepository } from "@/lib/astrologer";
import type { AstrologerProfile } from "@/types/astrologer";
import type { RankingContext } from "@/types/ranking";

/*
 * What each consultation length offers right now, from the live astrologer
 * pool: who can take a call that long (eligible, audio, minimum call time
 * fits), the cheapest total for it, and a few faces to show.
 */

export const DURATIONS = [3, 5, 10, 30] as const;
export type DurationMinutes = (typeof DURATIONS)[number];

export interface OfferAvatar {
  id: string;
  name: string;
  avatarUrl?: string;
  /** This astrologer's price for the card's duration (INR). */
  total: number;
  online: boolean;
  /** Catalog ids, so the booking dialog can match a subject and language. */
  languages: string[];
  topics: string[];
}

export interface DurationOffer {
  minutes: DurationMinutes;
  /** Cheapest total for this length (INR), or null if nobody can take it. */
  totalFrom: number | null;
  /** totalFrom ÷ minutes. */
  perMinuteFrom: number | null;
  /** Astrologers who can take a call this long. */
  experts: number;
  onlineNow: number;
  /** Up to MAX_AVATARS best-rated experts, varied across durations. */
  avatars: OfferAvatar[];
  /** Experts who take this length at totalFrom, best first: who a booking at the card price goes to. */
  atPrice: OfferAvatar[];
}

const MAX_AVATARS = 5;

// Platform-wide eligibility only: no user filters or preferences.
const BASE_CONTEXT: RankingContext = {
  user: {},
  context: {},
  filters: { onlineOnly: false },
  pagination: { limit: 1, offset: 0 },
};

/** Price of a call this long: an exact-length package if the astrologer sells one, else per-minute × minutes. */
export function priceFor(a: AstrologerProfile, minutes: number): number {
  const pkg = a.pricing.packages.find((p) => p.minutes === minutes);
  return pkg ? pkg.price : a.pricing.perMinute * minutes;
}

/** Whether the astrologer takes audio calls this long. */
export function canTake(a: AstrologerProfile, minutes: number): boolean {
  const modesOk = a.consultationModes.length === 0 || a.consultationModes.includes("audio");
  return modesOk && (a.pricing.minCallMinutes === null || a.pricing.minCallMinutes <= minutes);
}

/** Online first, then rating (unrated last), then review count. */
const byAppeal = (x: AstrologerProfile, y: AstrologerProfile) =>
  Number(y.availability.status === "online") - Number(x.availability.status === "online") ||
  (y.rating ?? -1) - (x.rating ?? -1) ||
  y.reviewCount - x.reviewCount ||
  x.id.localeCompare(y.id);

/** Astrologers who pass the platform's eligibility rules (no user filters). */
export async function listEligibleAstrologers(now = Date.now()): Promise<AstrologerProfile[]> {
  const all = await getAstrologerRepository().list();
  return all.filter((a) => checkEligibility(a, { ctx: BASE_CONTEXT, now }).eligible);
}

/**
 * Who a booking from a duration card can go to: eligible astrologers who
 * take that length at the card's price (totalFrom), best first.
 */
export async function getPricePool(minutes: DurationMinutes, now = Date.now()): Promise<AstrologerProfile[]> {
  const experts = (await listEligibleAstrologers(now)).filter((a) => canTake(a, minutes)).sort(byAppeal);
  if (experts.length === 0) return [];
  const totalFrom = Math.min(...experts.map((a) => priceFor(a, minutes)));
  return experts.filter((a) => priceFor(a, minutes) === totalFrom);
}

export async function getDurationOffers(now = Date.now()): Promise<DurationOffer[]> {
  const eligible = await listEligibleAstrologers(now);
  const shown = new Set<string>();

  return DURATIONS.map((minutes) => {
    const experts = eligible.filter((a) => canTake(a, minutes)).sort(byAppeal);
    const totals = experts.map((a) => priceFor(a, minutes));
    const totalFrom = totals.length ? Math.min(...totals) : null;

    // Prefer faces not already on an earlier card, so the cards don't all look the same.
    const fresh = experts.filter((a) => !shown.has(a.id));
    const picks = [...fresh, ...experts.filter((a) => shown.has(a.id))].slice(0, MAX_AVATARS);
    for (const a of picks) shown.add(a.id);

    const toAvatar = (a: AstrologerProfile): OfferAvatar => ({
      id: a.id,
      name: a.name,
      avatarUrl: a.avatarUrl,
      total: priceFor(a, minutes),
      online: a.availability.status === "online",
      languages: a.languages,
      topics: [...a.categories, ...a.specializations],
    });

    return {
      minutes,
      totalFrom,
      perMinuteFrom: totalFrom === null ? null : totalFrom / minutes,
      experts: experts.length,
      onlineNow: experts.filter((a) => a.availability.status === "online").length,
      avatars: picks.map(toAvatar),
      atPrice: experts.filter((a) => priceFor(a, minutes) === totalFrom).map(toAvatar),
    };
  });
}
