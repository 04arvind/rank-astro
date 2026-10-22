import type { AstrologerProfile, ProfileField } from "@/types/astrologer";
import { daysAgo, hoursAgo, NOW } from "./time";

/*
 * Controlled astrologer profiles in the common model. Each one exists to
 * exercise a specific business case (noted per entry). Ids are stable —
 * scenarios and tests refer to them through `ASTRO`.
 */

type Overrides = Partial<Omit<AstrologerProfile, "pricing" | "availability" | "dataQuality" | "source">> & {
  pricing?: Partial<AstrologerProfile["pricing"]>;
  availability?: Partial<AstrologerProfile["availability"]>;
  missing?: ProfileField[];
};

/** Builds a valid profile with sensible defaults; override only what matters. */
export function makeAstrologer(providerId: string, sourceId: string, o: Overrides = {}): AstrologerProfile {
  const { pricing, availability, missing = ["avatarUrl", "about"], ...rest } = o;
  return {
    id: `${providerId}:${sourceId}`,
    providerId,
    sourceId,
    name: sourceId
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" "),
    languages: ["hindi"],
    categories: ["career"],
    specializations: ["vedic"],
    consultationModes: ["audio", "chat"],
    experienceYears: 10,
    rating: 4.2,
    reviewCount: 50,
    verified: true,
    onboardedAt: daysAgo(400),
    ...rest,
    pricing: { perMinute: 50, minCallMinutes: 5, packages: [], payoutPerMinute: null, ...pricing },
    availability: { status: "online", lastActiveAt: NOW, ...availability },
    dataQuality: { missing, unmapped: [] },
    source: { importedAt: daysAgo(1), ref: `fixture:${sourceId}` },
  };
}

export const ASTRO = {
  // ---- Provider A (Astropatri-like) ----------------------------------------
  /** Premium, top-rated, experienced; strong conversion history. */
  arjun: makeAstrologer("providerA", "pandit-arjun-sharma", {
    languages: ["hindi", "english"],
    categories: ["career", "finance"],
    specializations: ["vedic", "kp"],
    experienceYears: 22,
    rating: 4.8,
    reviewCount: 640,
    pricing: { perMinute: 120, payoutPerMinute: 70, minCallMinutes: 10 },
  }),
  /** Budget love/marriage specialist, currently on a call (busy). */
  asha: makeAstrologer("providerA", "asha-verma", {
    categories: ["love", "marriage"],
    specializations: ["vedic", "numerology"],
    experienceYears: 8,
    rating: 4.5,
    reviewCount: 120,
    pricing: { perMinute: 45 },
    availability: { status: "busy" },
  }),
  /** Sparse onboarding-sheet record: no languages/categories/rating/availability. */
  ramesh: makeAstrologer("providerA", "ramesh-joshi", {
    languages: [],
    categories: [],
    specializations: [],
    experienceYears: null,
    rating: null,
    reviewCount: 0,
    pricing: { perMinute: 100 },
    availability: { status: "unknown", lastActiveAt: null },
    onboardedAt: null,
    missing: ["languages", "categories", "specializations", "experienceYears", "rating", "avatarUrl", "about", "availability", "onboardedAt", "payout"],
  }),
  /** Onboarding not complete → excluded (not_verified). */
  unverified: makeAstrologer("providerA", "kavita-unverified", { verified: false, pricing: { perMinute: 40 } }),

  // ---- Provider B (Talk to Guruji-like) -------------------------------------
  /** Tamil/English career & education expert; favourite of the loyal user. */
  meera: makeAstrologer("providerB", "acharya-meera-iyer", {
    languages: ["tamil", "english"],
    categories: ["career", "education"],
    specializations: ["numerology", "vedic"],
    experienceYears: 15,
    rating: 4.7,
    reviewCount: 310,
    pricing: { perMinute: 60, payoutPerMinute: 30, minCallMinutes: 15 },
    tier: "T2",
  }),
  /** Cheapest option; offline but active two hours ago. */
  harpreet: makeAstrologer("providerB", "guru-harpreet-singh", {
    languages: ["punjabi", "hindi"],
    categories: ["love", "health"],
    specializations: ["lal-kitab"],
    experienceYears: 12,
    rating: 4.3,
    reviewCount: 85,
    pricing: { perMinute: 35, payoutPerMinute: 17.5 },
    availability: { status: "offline", lastActiveAt: hoursAgo(2) },
    tier: "T1",
  }),
  /** Many reviews, poor rating → excluded (low_rating). */
  lowRated: makeAstrologer("providerB", "pandit-vikas-rao", {
    rating: 2.4,
    reviewCount: 60,
    pricing: { perMinute: 40, payoutPerMinute: 20 },
  }),
  /** Above the platform price ceiling → excluded (price_out_of_range). */
  overpriced: makeAstrologer("providerB", "acharya-sunil-dev", {
    rating: 4.9,
    reviewCount: 900,
    experienceYears: 30,
    pricing: { perMinute: 650, payoutPerMinute: 325 },
  }),

  // ---- Provider C (API feed) -------------------------------------------------
  /** Joined 5 days ago, no reviews or impressions yet — exploration candidate. */
  tara: makeAstrologer("providerC", "tara-new-tarot", {
    externalId: "C-501",
    languages: ["english"],
    categories: ["love"],
    specializations: ["tarot"],
    experienceYears: 3,
    rating: null,
    reviewCount: 0,
    pricing: { perMinute: 25, payoutPerMinute: 15 },
    onboardedAt: daysAgo(5),
  }),
  /** Vastu/finance expert; the favourite-only user's favourite. */
  dev: makeAstrologer("providerC", "dev-vastu-expert", {
    externalId: "C-502",
    languages: ["hindi", "marathi"],
    categories: ["finance", "career"],
    specializations: ["vastu"],
    experienceYears: 18,
    rating: 4.6,
    reviewCount: 200,
    pricing: { perMinute: 80, payoutPerMinute: 40 },
  }),
  /** Good profile but a complaint-heavy call history → excluded (high_complaint_rate). */
  complaints: makeAstrologer("providerC", "nikhil-complaints", {
    externalId: "C-503",
    languages: ["hindi", "english"],
    categories: ["love"],
    rating: 4.1,
    reviewCount: 40,
    pricing: { perMinute: 50, payoutPerMinute: 30 },
  }),
  /** Bengali reiki healer; covers a less common language + health. */
  rupa: makeAstrologer("providerC", "rupa-bengali-healer", {
    externalId: "C-504",
    languages: ["bengali", "english"],
    categories: ["health"],
    specializations: ["reiki"],
    experienceYears: 9,
    rating: 4.4,
    reviewCount: 40,
    pricing: { perMinute: 55, payoutPerMinute: 33 },
  }),
} as const satisfies Record<string, AstrologerProfile>;

export type AstroKey = keyof typeof ASTRO;

export const ALL_ASTROLOGERS: AstrologerProfile[] = Object.values(ASTRO);

/** Astrologers that should pass eligibility with default filters. */
export const ELIGIBLE_BY_DEFAULT: AstroKey[] = ["arjun", "asha", "ramesh", "meera", "harpreet", "tara", "dev", "rupa"];
