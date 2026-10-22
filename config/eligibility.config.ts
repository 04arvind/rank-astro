import type { EligibilityConfig } from "./schema";

/** Hard filters: an astrologer failing any of these is not scored at all. */
export const eligibilityConfig = {
  quality: {
    minRating: 3.0,
    minReviews: 5,
    maxComplaintRate: 0.15,
  },
  price: {
    perMinute: { min: 5, max: 500 },
  },
  availability: {
    includeOffline: true,
    recentlyActiveHours: 72,
  },
  profile: {
    requireVerified: true,
    requireAvatar: false,
    minLanguages: 1,
    minCategories: 1,
  },
  newAstrologerGraceDays: 30,
  // Current provider feeds lack ratings/languages for many profiles.
  missingData: "pass",
} satisfies EligibilityConfig;
