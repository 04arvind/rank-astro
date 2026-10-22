import { config } from "@/config";
import { getAstrologerRepository, type AstrologerRepository } from "@/lib/astrologer";
import type { UserSignals } from "@/types/user";
import { computeAffinities, getCallHistory, previousAstrologers } from "./history";
import {
  getExplicitPreferences,
  getFavorites,
  resolveCategoryPreference,
  resolveLanguagePreference,
  resolvePricePreference,
} from "./preferences";
import { getUserProfile } from "./profile";

export interface UserSignalOptions {
  now?: number;
  /** Where to look up profiles of previously called astrologers. */
  repository?: AstrologerRepository;
}

/** Signals for a visitor with no id: no history, no preferences. */
export function anonymousUserSignals(): UserSignals {
  return {
    segment: "newUser",
    favorites: [],
    previousAstrologers: [],
    categoryAffinity: new Map(),
    languageAffinity: new Map(),
    providerAffinity: new Map(),
    languagePreference: { languages: [], source: "none" },
    categoryPreference: { categories: [], source: "none" },
    pricePreference: { typical: null, source: "none" },
  };
}

/**
 * Everything the ranking engine needs about a user, in one call: profile,
 * explicit preferences, favourites, call history, and the affinities and
 * resolved preferences derived from them.
 */
export async function getUserSignals(
  userId: string | undefined,
  { now = Date.now(), repository = getAstrologerRepository() }: UserSignalOptions = {},
): Promise<UserSignals> {
  if (!userId) return anonymousUserSignals();

  const [profile, explicit, favorites, history] = await Promise.all([
    getUserProfile(userId),
    getExplicitPreferences(userId),
    getFavorites(userId),
    getCallHistory(userId, now),
  ]);
  const called = await repository.getByIds(history.astrologers.map((h) => h.astrologerId));
  const affinities = computeAffinities(history, called);

  return {
    userId,
    // Favourites are an expressed preference, so they unlock personalised weights too.
    segment:
      history.completedCalls >= config.ranking.segmentation.returningUserMinCalls || favorites.length > 0
        ? "returningUser"
        : "newUser",
    profile,
    history,
    favorites: favorites.map((f) => f.astrologerId),
    previousAstrologers: previousAstrologers(history),
    categoryAffinity: affinities.category,
    languageAffinity: affinities.language,
    providerAffinity: affinities.provider,
    languagePreference: resolveLanguagePreference(explicit, affinities.language),
    categoryPreference: resolveCategoryPreference(explicit),
    pricePreference: resolvePricePreference(explicit, history),
  };
}

export { getUserProfile, upsertUserProfile, type UserProfileInput } from "./profile";
export {
  addFavorite,
  getExplicitPreferences,
  getFavorites,
  removeFavorite,
  setUserPreferences,
  type UserPreferencesInput,
} from "./preferences";
export { getCallHistory, previousAstrologers } from "./history";
export { getUserStore, setUserStore, InMemoryUserStore, type UserStore } from "./store";
