import { z } from "zod";
import {
  cell,
  consultationModes,
  httpUrl,
  list,
  mapToCatalog,
  minutes,
  money,
  slugify,
  text,
  years,
} from "./parsers";
import type { PricePackage } from "@/types/astrologer";
import { missingFields, type ProviderAdapter } from "./types";

/**
 * Talk to Guruji — panel profile sheet (data/csv/talk_to_guruji.xlsx,
 * "Panel Profile Data"). Values are bilingual ("Hindi | हिंदी"); "Final Price"
 * is what the user pays, "Astrologer Charge" is the payout.
 */
const raw = z.object({
  "Name of the Expert": cell,
  "Tag line": cell,
  "Category | tag": cell,
  "About the expert": cell,
  "Expert Image": cell,
  Expertise: cell,
  Tier: cell,
  "Per Minute": cell,
  "Astrologer Charge (15 Min)": cell,
  "Final Price (15 Min)": cell,
  "Astrologer Charge (30 Min)": cell,
  "Final Price (30 Min)": cell,
  Duration: cell,
  "Year of experience": cell,
  "Known languages": cell,
  "Consultation Mode": cell,
});

type Raw = z.output<typeof raw>;

export const providerB: ProviderAdapter<Raw> = {
  id: "providerB",
  feed: { format: "xlsx", sheet: "Panel Profile Data", defaultPath: "data/csv/talk_to_guruji.xlsx" },
  rawSchema: raw,

  toProfile(r) {
    const name = text(r["Name of the Expert"]) ?? "";

    const rawLanguages = list(r["Known languages"]);
    const rawSpecs = [...(list(r["Category | tag"]) ?? []), ...(list(r.Expertise) ?? [])];
    const rawModes = list(r["Consultation Mode"]);
    const languages = mapToCatalog("languages", rawLanguages ?? []);
    const specializations = mapToCatalog("specializations", rawSpecs);

    const f15 = money(r["Final Price (15 Min)"]);
    const f30 = money(r["Final Price (30 Min)"]);
    const packages: PricePackage[] = [];
    if (f15 !== undefined) packages.push({ minutes: 15, price: f15 });
    if (f30 !== undefined) packages.push({ minutes: 30, price: f30 });

    const c30 = money(r["Astrologer Charge (30 Min)"]);
    const c15 = money(r["Astrologer Charge (15 Min)"]);
    const payoutPerMinute = c30 !== undefined ? c30 / 30 : c15 !== undefined ? c15 / 15 : null;

    const experience = years(r["Year of experience"]);
    const avatarUrl = httpUrl(r["Expert Image"]);
    const about = text(r["About the expert"]);

    return {
      sourceId: slugify(name),
      name,
      tagline: text(r["Tag line"]),
      about,
      avatarUrl,
      languages: languages.ids,
      // Sheet lists disciplines only; consultation topics aren't supplied.
      categories: [],
      specializations: specializations.ids,
      consultationModes: consultationModes(rawModes ?? []),
      experienceYears: experience ?? null,
      rating: null,
      reviewCount: 0,
      pricing: {
        perMinute: money(r["Per Minute"]) ?? (f15 !== undefined ? f15 / 15 : 0),
        minCallMinutes: minutes(r.Duration) ?? null,
        packages,
        payoutPerMinute,
      },
      availability: { status: "unknown", lastActiveAt: null },
      tier: text(r.Tier),
      // Assumption: profiles on the curated panel sheet are verified.
      verified: true,
      onboardedAt: null,
      dataQuality: {
        missing: missingFields({
          languages: rawLanguages,
          categories: undefined,
          specializations: rawSpecs.length ? rawSpecs : undefined,
          experienceYears: experience,
          rating: undefined,
          avatarUrl,
          about,
          availability: undefined,
          consultationModes: rawModes,
          onboardedAt: undefined,
          payout: payoutPerMinute ?? undefined,
        }),
        unmapped: [...languages.unmapped, ...specializations.unmapped],
      },
    };
  },
};
