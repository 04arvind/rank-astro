import type { UserConfig } from "./schema";

/** How user preferences are derived for personalisation (lib/user). */
export const userConfig = {
  derivedLanguageMinShare: 0.3,
  maxDerivedLanguages: 2,
  maxFavorites: 100,
  maxPreviousAstrologers: 20,
} satisfies UserConfig;
