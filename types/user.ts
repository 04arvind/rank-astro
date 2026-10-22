import type { UserSegment } from "@/config";
import type { UserCallSummary } from "./analytics";
import type { Platform } from "./ranking";

/** Stored user profile. Contact/PII fields are intentionally absent. */
export interface UserProfile {
  userId: string;
  displayName?: string;
  /** Epoch ms. */
  createdAt: number;
  platform?: Platform;
}

/** Preferences the user set explicitly (onboarding, settings). */
export interface UserPreferences {
  userId: string;
  /** Catalog language ids, most preferred first. */
  languages: string[];
  /** Catalog category ids. */
  categories: string[];
  priceRange?: { min?: number; max?: number };
  updatedAt: number;
}

export interface FavoriteAstrologer {
  astrologerId: string;
  addedAt: number;
}

export interface PreviousAstrologer {
  astrologerId: string;
  providerId: string;
  completedCalls: number;
  totalSpend: number;
  lastCallAt: number;
}

export type PreferenceSource = "explicit" | "history" | "none";

export interface PricePreference {
  min?: number;
  max?: number;
  /** The per-minute price the user typically pays or asked for. */
  typical: number | null;
  source: PreferenceSource;
}

export type { UserSegment };

/**
 * Everything the ranking engine needs to personalise results, resolved from
 * profile, explicit preferences, favourites and call history. Values are
 * facts and shares — never scores.
 */
export interface UserSignals {
  userId?: string;
  segment: UserSegment;
  profile?: UserProfile;
  history?: UserCallSummary;
  /** Astrologer ids, most recently favourited first. */
  favorites: string[];
  /** Astrologers the user completed calls with, most recent first. */
  previousAstrologers: PreviousAstrologer[];
  /** Share of completed calls per category/specialization tag (0..1). */
  categoryAffinity: ReadonlyMap<string, number>;
  /** Share of completed calls with astrologers speaking each language (0..1). */
  languageAffinity: ReadonlyMap<string, number>;
  /** Share of completed calls per provider (0..1). */
  providerAffinity: ReadonlyMap<string, number>;
  /** Explicit languages first, then ones inferred from history. */
  languagePreference: { languages: string[]; source: PreferenceSource };
  /** Explicit categories only — history holds disciplines, not topics. */
  categoryPreference: { categories: string[]; source: PreferenceSource };
  pricePreference: PricePreference;
}
