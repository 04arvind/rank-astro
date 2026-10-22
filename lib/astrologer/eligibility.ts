import { config } from "@/config";
import { EligibilityError } from "@/lib/errors";
import { DAY_MS, HOUR_MS } from "@/lib/utils/time";
import type { AstrologerMetrics } from "@/types/analytics";
import type { AstrologerProfile, ProfileField } from "@/types/astrologer";
import type { RankingContext } from "@/types/ranking";


export type ExclusionReason =
  | "provider_disabled"
  | "provider_filtered"
  | "not_verified"
  | "price_out_of_range"
  | "price_filter"
  | "not_online"
  | "inactive"
  | "low_rating"
  | "high_complaint_rate"
  | "too_few_languages"
  | "too_few_categories"
  | "no_avatar";

export interface EligibilityResult {
  eligible: boolean;
  reasons: ExclusionReason[];
}

export interface EligibilityInput {
  ctx: Pick<RankingContext, "filters" | "context">;
  metrics?: AstrologerMetrics;
  now?: number;
}

/** Whether the provider never supplied `field` (vs. supplied it empty). */
const isMissing = (a: AstrologerProfile, field: ProfileField) => a.dataQuality.missing.includes(field);

/**
 * Hard filters from config.eligibility plus the request's explicit filters.
 * Returns every failed rule (not just the first) so debug output is complete.
 * Soft preferences (language, category) are ranking signals, not filters.
 */
export function checkEligibility(
  a: AstrologerProfile,
  { ctx, metrics, now = Date.now() }: EligibilityInput,
): EligibilityResult {
  const rules = config.eligibility;
  const reasons: ExclusionReason[] = [];
  const fail = (r: ExclusionReason) => reasons.push(r);
  /** Missing-data policy: when the field is unknown, pass or fail per config. */
  const unknown = (field: ProfileField) => isMissing(a, field) && rules.missingData === "pass";

  // Provider
  const provider = config.providers.providers.find((p) => p.id === a.providerId);
  if (!provider?.enabled) fail("provider_disabled");
  if (ctx.filters.providerIds?.length && !ctx.filters.providerIds.includes(a.providerId)) {
    fail("provider_filtered");
  }

  // Profile
  if (rules.profile.requireVerified && !a.verified) fail("not_verified");
  if (rules.profile.requireAvatar && !a.avatarUrl && !unknown("avatarUrl")) fail("no_avatar");
  if (a.languages.length < rules.profile.minLanguages && !unknown("languages")) fail("too_few_languages");
  const topicCount = a.categories.length + a.specializations.length;
  if (topicCount < rules.profile.minCategories && !(unknown("categories") && unknown("specializations"))) {
    fail("too_few_categories");
  }

  // Price
  const price = a.pricing.perMinute;
  if (price < rules.price.perMinute.min || price > rules.price.perMinute.max) fail("price_out_of_range");
  const wanted = ctx.context.priceRange;
  if (wanted && ((wanted.min !== undefined && price < wanted.min) || (wanted.max !== undefined && price > wanted.max))) {
    fail("price_filter");
  }

  // Availability
  const { status, lastActiveAt } = a.availability;
  if (ctx.filters.onlineOnly && status !== "online") fail("not_online");
  if (!rules.availability.includeOffline && status === "offline") {
    const recent = lastActiveAt !== null && now - lastActiveAt <= rules.availability.recentlyActiveHours * HOUR_MS;
    if (!recent) fail("inactive");
  }
  if (status === "unknown" && rules.missingData === "fail") fail("inactive");

  // Quality floors — skipped during the new-astrologer grace period, and only
  // enforced once there are enough reviews to judge.
  const inGrace = a.onboardedAt !== null && now - a.onboardedAt <= rules.newAstrologerGraceDays * DAY_MS;
  if (!inGrace) {
    const rating = metrics?.avgRating ?? a.rating;
    const reviews = Math.max(a.reviewCount, metrics?.ratingCount ?? 0);
    if (rating !== null && reviews >= rules.quality.minReviews && rating < rules.quality.minRating) {
      fail("low_rating");
    }
    if (rating === null && isMissing(a, "rating") && rules.missingData === "fail") fail("low_rating");

    const complaintRate = metrics?.complaintRate ?? null;
    if (
      complaintRate !== null &&
      (metrics?.ratingCount ?? 0) >= rules.quality.minReviews &&
      complaintRate > rules.quality.maxComplaintRate
    ) {
      fail("high_complaint_rate");
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

/** Throws EligibilityError (with every failed rule) when the astrologer is not eligible. */
export function assertEligible(a: AstrologerProfile, input: EligibilityInput): void {
  const { eligible, reasons } = checkEligibility(a, input);
  if (!eligible) throw new EligibilityError(a.id, reasons);
}
