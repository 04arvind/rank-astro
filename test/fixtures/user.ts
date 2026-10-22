import type { UserPreferencesInput } from "@/lib/user";
import type { UserProfile } from "@/types/user";
import { ASTRO } from "./astrologers";
import { daysAgo } from "./time";

/*
 * Sample users covering the personalisation cases. Call history lives in
 * history.ts (it's analytics data); this file holds what lib/user stores.
 */

export interface UserFixture {
  userId?: string;
  description: string;
  profile?: UserProfile;
  preferences?: UserPreferencesInput;
  /** Astrologer ids, most recent first. */
  favorites?: string[];
}

export const USERS = {
  /** Never signed in: no id, no history, no preferences. */
  anonymous: { description: "First-time anonymous visitor" },

  /** Signed up today, nothing else known. */
  newRegistered: {
    userId: "user-new",
    description: "Registered first-time user with no activity",
    profile: { userId: "user-new", createdAt: daysAgo(0), platform: "android" },
  },

  /** Set explicit preferences during onboarding; no calls yet. */
  englishCareer: {
    userId: "user-english-career",
    description: "New user who chose English, career topics and ₹40–80/min",
    profile: { userId: "user-english-career", createdAt: daysAgo(2), platform: "web" },
    preferences: { languages: ["english"], categories: ["career"], priceRange: { min: 40, max: 80 } },
  },

  /** Frequent caller with one clear favourite astrologer (see history.ts). */
  loyal: {
    userId: "user-returning-loyal",
    description: "Returning user: 4 recent calls with Meera, 1 with Dev",
    profile: { userId: "user-returning-loyal", createdAt: daysAgo(120), platform: "ios" },
  },

  /** Saved a favourite but never called. */
  favoriteOnly: {
    userId: "user-favourite",
    description: "Has favourited Dev but never completed a call",
    profile: { userId: "user-favourite", createdAt: daysAgo(10), platform: "web" },
    favorites: [ASTRO.dev.id],
  },

  /** Always picks cheap astrologers. */
  budget: {
    userId: "user-budget",
    description: "Price-sensitive: calls only ₹35–45/min astrologers",
    profile: { userId: "user-budget", createdAt: daysAgo(60), platform: "android" },
  },

  /** Repeatedly books the premium astrologer. */
  premium: {
    userId: "user-premium",
    description: "High spender: repeated long calls with ₹120/min Arjun",
    profile: { userId: "user-premium", createdAt: daysAgo(200), platform: "ios" },
  },

  /** One call five months ago — history should have faded. */
  lapsed: {
    userId: "user-lapsed",
    description: "Single call with Asha 150 days ago",
    profile: { userId: "user-lapsed", createdAt: daysAgo(300), platform: "web" },
  },
} as const satisfies Record<string, UserFixture>;

export type UserKey = keyof typeof USERS;
