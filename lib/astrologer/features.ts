import { config } from "@/config";
import { ratio } from "@/lib/utils/math";
import { daysSince, hoursSince } from "@/lib/utils/time";
import type { AstrologerMetrics } from "@/types/analytics";
import type { AstrologerProfile, ProfileField } from "@/types/astrologer";
import type { RankingContext } from "@/types/ranking";
import type { UserSignals } from "@/types/user";


/**
 * Model-ready inputs per candidate. Features are raw or lightly derived
 * facts (counts, rates, overlaps) — never weighted or scored. Signal
 * functions in lib/ranking turn them into scores; an ML model can consume
 * the same vector directly. `null` means "unknown", distinct from 0.
 */
export const FEATURE_NAMES = [
  // Profile
  "rating",
  "reviewCount",
  "experienceYears",
  "pricePerMinute",
  "priceBand",
  "payoutPerMinute",
  "marginRate",
  "minCallMinutes",
  "consultationModeCount",
  "specializationCount",
  "verified",
  // Availability
  "isOnline",
  "isBusy",
  "hoursSinceActive",
  // Request fit
  "languageOverlap",
  "categoryMatch",
  // Lifecycle
  "ageDays",
  "isNew",
  // Observed performance (lib/analytics)
  "impressions",
  "clicks",
  "completedCalls",
  "ctr",
  "clickToCallRate",
  "conversionRate",
  "responseRate",
  "repeatRate",
  "avgCallMinutes",
  "observedRating",
  "observedRatingCount",
  "complaintRate",
  "revenuePerImpression",
  // User history
  "userIsReturning",
  "isFavorite",
  "userCallsWithAstrologer",
  "daysSinceUserLastCall",
  "userTypicalPricePerMinute",
  "priceDeltaRatio",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureVector = Record<FeatureName, number | null>;

export interface CandidateFeatures {
  astrologerId: string;
  providerId: string;
  features: FeatureVector;
}

export interface FeatureInput {
  ctx: RankingContext;
  metrics?: ReadonlyMap<string, AstrologerMetrics>;
  user?: Pick<UserSignals, "userId" | "segment" | "history" | "favorites" | "pricePreference">;
  now?: number;
}

const flag = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

/** 0 = budget, 1 = standard, 2 = premium (config.business.priceBands). */
function priceBand(price: number): number {
  const { budgetMax, standardMax } = config.business.priceBands;
  return price <= budgetMax ? 0 : price <= standardMax ? 1 : 2;
}

export function prepareFeatures(
  candidates: readonly AstrologerProfile[],
  { ctx, metrics, user, now = Date.now() }: FeatureInput,
): CandidateFeatures[] {
  const { category, languages: wantedLanguages } = ctx.context;
  const { newAstrologer } = config.exploration;
  const knownUser = user?.userId !== undefined;
  const historyByAstrologer = new Map(user?.history?.astrologers.map((h) => [h.astrologerId, h]));
  const favorites = new Set(user?.favorites);
  const typicalPrice = user?.pricePreference.typical ?? null;

  return candidates.map((a) => {
    const m = metrics?.get(a.id);
    const h = historyByAstrologer.get(a.id);
    const price = a.pricing.perMinute;
    const payout = a.pricing.payoutPerMinute;
    const status = a.availability.status;
    const known = (field: ProfileField) => !a.dataQuality.missing.includes(field);

    const ageDays = a.onboardedAt !== null ? daysSince(a.onboardedAt, now) : null;
    const impressions = m?.impressions ?? 0;
    // New = young and under-exposed; unknown age only resolves once exposure rules it out.
    let isNew: boolean | null;
    if (impressions >= newAstrologer.maxImpressions) isNew = false;
    else if (ageDays === null) isNew = null;
    else isNew = ageDays <= newAstrologer.maxAgeDays;

    const features: FeatureVector = {
      rating: a.rating,
      reviewCount: a.reviewCount,
      experienceYears: a.experienceYears,
      pricePerMinute: price,
      priceBand: priceBand(price),
      payoutPerMinute: payout,
      marginRate: payout !== null ? (price - payout) / price : null,
      minCallMinutes: a.pricing.minCallMinutes,
      consultationModeCount: a.consultationModes.length,
      specializationCount: known("specializations") ? a.specializations.length : null,
      verified: flag(a.verified),

      isOnline: status === "unknown" ? null : flag(status === "online"),
      isBusy: status === "unknown" ? null : flag(status === "busy"),
      hoursSinceActive: a.availability.lastActiveAt !== null ? hoursSince(a.availability.lastActiveAt, now) : null,

      languageOverlap:
        wantedLanguages?.length && known("languages")
          ? wantedLanguages.filter((l) => a.languages.includes(l)).length / wantedLanguages.length
          : null,
      categoryMatch: category && known("categories") ? flag(a.categories.includes(category)) : null,

      ageDays,
      isNew: flag(isNew),

      impressions,
      clicks: m?.clicks ?? 0,
      completedCalls: m?.completedCalls ?? 0,
      ctr: m?.ctr ?? null,
      clickToCallRate: m?.clickToCallRate ?? null,
      conversionRate: m?.conversionRate ?? null,
      responseRate: m?.responseRate ?? null,
      repeatRate: m?.repeatRate ?? null,
      avgCallMinutes: m?.avgCallSeconds != null ? m.avgCallSeconds / 60 : null,
      observedRating: m?.avgRating ?? null,
      observedRatingCount: m?.ratingCount ?? 0,
      complaintRate: m?.complaintRate ?? null,
      revenuePerImpression: m?.revenuePerImpression ?? null,

      userIsReturning: knownUser ? flag(user?.segment === "returningUser") : null,
      isFavorite: knownUser ? flag(favorites.has(a.id)) : null,
      userCallsWithAstrologer: knownUser ? (h?.completedCalls ?? 0) : null,
      daysSinceUserLastCall: h ? daysSince(h.lastCallAt, now) : null,
      userTypicalPricePerMinute: typicalPrice,
      priceDeltaRatio: typicalPrice !== null ? ratio(price - typicalPrice, typicalPrice) : null,
    };

    return { astrologerId: a.id, providerId: a.providerId, features };
  });
}
