import { z } from "zod";
import { config } from "@/config";
import { ValidationError } from "@/lib/errors";
import { topEntries } from "@/lib/utils/collections";
import { parseOrThrow } from "@/lib/utils/validation";
import type { UserCallSummary } from "@/types/analytics";
import type {
  FavoriteAstrologer,
  PreferenceSource,
  PricePreference,
  UserPreferences,
} from "@/types/user";
import { getUserStore } from "./store";

// ---------------------------------------------------------------------------
// Explicit preferences
// ---------------------------------------------------------------------------

const catalogIds = (kind: "languages" | "categories") => {
  const ids = new Set(config.catalog[kind].map((o) => o.id));
  return z
    .array(z.string().trim().toLowerCase())
    .max(20)
    .refine((xs) => xs.every((x) => ids.has(x)), { message: `unknown ${kind} id` })
    .transform((xs) => [...new Set(xs)]);
};

const preferencesInput = z.object({
  languages: catalogIds("languages").default([]),
  categories: catalogIds("categories").default([]),
  priceRange: z
    .object({ min: z.number().nonnegative().optional(), max: z.number().nonnegative().optional() })
    .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, { message: "min must be <= max" })
    .optional(),
});

export type UserPreferencesInput = z.input<typeof preferencesInput>;

export async function getExplicitPreferences(userId: string): Promise<UserPreferences | undefined> {
  return getUserStore().getPreferences(userId);
}

export async function setUserPreferences(userId: string, input: UserPreferencesInput): Promise<UserPreferences> {
  const data = parseOrThrow(preferencesInput, input, (issues) => new ValidationError("Invalid user preferences", issues));
  const prefs: UserPreferences = { userId, ...data, updatedAt: Date.now() };
  await getUserStore().savePreferences(prefs);
  return prefs;
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

/** Most recently added first. */
export async function getFavorites(userId: string): Promise<FavoriteAstrologer[]> {
  return getUserStore().getFavorites(userId);
}

export async function addFavorite(userId: string, astrologerId: string, now = Date.now()): Promise<FavoriteAstrologer[]> {
  const store = getUserStore();
  const current = (await store.getFavorites(userId)).filter((f) => f.astrologerId !== astrologerId);
  const next = [{ astrologerId, addedAt: now }, ...current].slice(0, config.user.maxFavorites);
  await store.saveFavorites(userId, next);
  return next;
}

export async function removeFavorite(userId: string, astrologerId: string): Promise<FavoriteAstrologer[]> {
  const store = getUserStore();
  const next = (await store.getFavorites(userId)).filter((f) => f.astrologerId !== astrologerId);
  await store.saveFavorites(userId, next);
  return next;
}

// ---------------------------------------------------------------------------
// Resolved preferences: explicit wins, history fills gaps
// ---------------------------------------------------------------------------

/**
 * Explicit languages first, then languages used in at least
 * derivedLanguageMinShare of the user's calls (strongest first).
 */
export function resolveLanguagePreference(
  explicit: UserPreferences | undefined,
  languageAffinity: ReadonlyMap<string, number>,
): { languages: string[]; source: PreferenceSource } {
  const { derivedLanguageMinShare, maxDerivedLanguages } = config.user;
  const derived = topEntries(languageAffinity)
    .filter(([, share]) => share >= derivedLanguageMinShare)
    .slice(0, maxDerivedLanguages)
    .map(([id]) => id);

  const explicitLangs = explicit?.languages ?? [];
  if (explicitLangs.length) return { languages: [...new Set([...explicitLangs, ...derived])], source: "explicit" };
  if (derived.length) return { languages: derived, source: "history" };
  return { languages: [], source: "none" };
}

export function resolveCategoryPreference(
  explicit: UserPreferences | undefined,
): { categories: string[]; source: PreferenceSource } {
  const categories = explicit?.categories ?? [];
  return { categories, source: categories.length ? "explicit" : "none" };
}

/** An explicit range wins; otherwise the range and average of prices actually paid. */
export function resolvePricePreference(
  explicit: UserPreferences | undefined,
  history: UserCallSummary | undefined,
): PricePreference {
  const range = explicit?.priceRange;
  if (range && (range.min !== undefined || range.max !== undefined)) {
    const typical =
      range.min !== undefined && range.max !== undefined ? (range.min + range.max) / 2 : (range.max ?? range.min ?? null);
    return { min: range.min, max: range.max, typical, source: "explicit" };
  }

  const paid = history?.astrologers.map((a) => a.avgPricePerMinute) ?? [];
  if (paid.length && history?.avgPricePerMinute != null) {
    return { min: Math.min(...paid), max: Math.max(...paid), typical: history.avgPricePerMinute, source: "history" };
  }
  return { typical: null, source: "none" };
}
