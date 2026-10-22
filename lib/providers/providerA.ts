import { z } from "zod";
import { cell, httpUrl, money, minutes, slugify, text, urlSlug } from "./parsers";
import type { PricePackage } from "@/types/astrologer";
import { missingFields, type ProviderAdapter } from "./types";

/**
 * Astropatri — onboarding sheet (data/csv/astropatri.xlsx, Sheet1).
 * Supplies pricing and a profile link only; no languages, categories,
 * experience or ratings. Contact columns are intentionally not read.
 */
const raw = z.object({
  Name: cell,
  Slot: cell,
  "Per minute call": cell,
  "Call/chat Price (30 Min)": cell,
  "per 5 min cost": cell,
  "Min call time": cell,
  Link: cell,
});

type Raw = z.output<typeof raw>;

export const providerA: ProviderAdapter<Raw> = {
  id: "providerA",
  feed: { format: "xlsx", sheet: "Sheet1", defaultPath: "data/csv/astropatri.xlsx" },
  rawSchema: raw,

  toProfile(r) {
    const name = text(r.Name) ?? "";
    const packages: PricePackage[] = [];
    const p5 = money(r["per 5 min cost"]);
    const p30 = money(r["Call/chat Price (30 Min)"]);
    if (p5 !== undefined) packages.push({ minutes: 5, price: p5 });
    if (p30 !== undefined) packages.push({ minutes: 30, price: p30 });

    return {
      sourceId: urlSlug(r.Link) ?? slugify(name),
      name,
      profileUrl: httpUrl(r.Link),
      languages: [],
      categories: [],
      specializations: [],
      // Sheet prices "call/chat" together.
      consultationModes: ["audio", "chat"],
      experienceYears: null,
      rating: null,
      reviewCount: 0,
      pricing: {
        perMinute: money(r["Per minute call"]) ?? 0,
        minCallMinutes: minutes(r["Min call time"]) ?? null,
        packages,
        payoutPerMinute: null,
      },
      availability: { status: "unknown", lastActiveAt: null },
      // Assumption: an astrologer counts as verified once the onboarding meeting is done.
      verified: r.Slot?.toLowerCase() === "meet done",
      onboardedAt: null,
      dataQuality: {
        missing: missingFields({
          languages: undefined,
          categories: undefined,
          specializations: undefined,
          experienceYears: undefined,
          rating: undefined,
          avatarUrl: undefined,
          about: undefined,
          availability: undefined,
          onboardedAt: undefined,
          payout: undefined,
        }),
        unmapped: [],
      },
    };
  },
};
