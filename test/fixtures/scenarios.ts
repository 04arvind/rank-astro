import type { ScoreName, SignalName, UserSegment } from "@/config";
import type { ExclusionReason } from "@/lib/astrologer";
import type { AdjustmentName, RankingContext } from "@/types/ranking";
import { ASTRO, type AstroKey } from "./astrologers";
import { BASE_HISTORY, mergeHistory, viewerImpressions, type HistorySet } from "./history";
import type { TrafficPreset } from "./providers";
import { USERS, type UserKey } from "./user";

/*
 * Ranking scenarios: a request plus the data to seed, and declarative
 * expectations describing the intended business outcome. Expectations are
 * data only — tests decide how to assert them.
 */

export type Sign = "positive" | "zero" | "negative" | "nonPositive";

export interface ScenarioExpectations {
  segment?: UserSegment;
  /** Must be excluded, with at least these reasons. */
  excluded?: Partial<Record<AstroKey, ExclusionReason[]>>;
  /** Must be eligible (appear somewhere in the ranking). */
  eligible?: AstroKey[];
  /** Must appear within the first `n` results. */
  top?: { n: number; include: AstroKey[] };
  /** Pairs [higher, lower] in final rank. */
  ranksAbove?: [AstroKey, AstroKey][];
  /** User-facing reason fragments that must appear for an astrologer. */
  reasonsInclude?: Partial<Record<AstroKey, string[]>>;
  /** Reason fragments that must NOT appear. */
  reasonsExclude?: Partial<Record<AstroKey, string[]>>;
  /**
   * Sign of a weighted contribution: a composite score (e.g. "categoryScore"),
   * an adjustment ("providerBooster", "quotaUrgencyBoost", "frequencyPenalty")
   * or a single component (e.g. "repeatAstrologer").
   */
  signalSign?: Partial<Record<AstroKey, Partial<Record<SignalName | ScoreName | AdjustmentName, Sign>>>>;
  /** Must be placed in an exploration slot or carry a positive exploration signal. */
  explored?: AstroKey[];
}

export interface RankingScenario {
  id: string;
  title: string;
  /** The business rule this scenario protects. */
  businessCase: string;
  user: UserKey;
  request: RankingContext;
  /** Analytics history to load (defaults to BASE_HISTORY + the user's own calls). */
  history?: HistorySet;
  /** Recent provider traffic preset, if the case is about utilization. */
  traffic?: TrafficPreset;
  expect: ScenarioExpectations;
}

/** Builds a request for a fixture user; the session id is fixed per scenario. */
function request(user: UserKey, scenarioId: string, over: Partial<RankingContext> = {}): RankingContext {
  const u = USERS[user] as { userId?: string };
  return {
    user: { userId: u.userId, sessionId: `scenario-${scenarioId}` },
    context: over.context ?? {},
    filters: { onlineOnly: false, ...over.filters },
    pagination: { limit: 20, offset: 0, ...over.pagination },
  };
}

export const SCENARIOS: RankingScenario[] = [
  {
    id: "first-time-anonymous",
    title: "First-time anonymous visitor asking for Hindi",
    businessCase: "New users see high-quality, relevant astrologers; unsafe or unqualified profiles never appear.",
    user: "anonymous",
    request: request("anonymous", "first-time-anonymous", { context: { languages: ["hindi"] } }),
    expect: {
      segment: "newUser",
      excluded: {
        unverified: ["not_verified"],
        lowRated: ["low_rating"],
        overpriced: ["price_out_of_range"],
        complaints: ["high_complaint_rate"],
      },
      eligible: ["arjun", "asha", "ramesh", "harpreet", "dev"],
      top: { n: 3, include: ["arjun"] },
      reasonsInclude: { arjun: ["Speaks Hindi"] },
      reasonsExclude: { arjun: ["You've consulted", "favourites"] },
    },
  },
  {
    id: "new-registered-no-history",
    title: "Registered user with no activity",
    businessCase: "A profile alone doesn't make a user 'returning'; they get the new-user weighting.",
    user: "newRegistered",
    request: request("newRegistered", "new-registered-no-history"),
    expect: { segment: "newUser", eligible: ["arjun", "meera", "tara"] },
  },
  {
    id: "category-love-budget",
    title: "Love consultation up to ₹60/min",
    businessCase: "An explicit price cap is a hard filter; category specialists get category credit, non-specialists don't.",
    user: "anonymous",
    request: request("anonymous", "category-love-budget", { context: { category: "love", priceRange: { max: 60 } } }),
    expect: {
      excluded: { arjun: ["price_filter"], dev: ["price_filter"], ramesh: ["price_filter"] },
      eligible: ["asha", "harpreet", "tara", "meera"],
      reasonsInclude: { asha: ["Specialises in Love"] },
      signalSign: {
        asha: { categoryMatch: "positive" },
        tara: { categoryMatch: "positive" },
        meera: { categoryMatch: "zero" },
      },
    },
  },
  {
    id: "online-only",
    title: "Only astrologers available right now",
    businessCase: "'Available now' requests exclude busy, offline and unknown-status astrologers.",
    user: "anonymous",
    request: request("anonymous", "online-only", { filters: { onlineOnly: true } }),
    expect: {
      excluded: { asha: ["not_online"], harpreet: ["not_online"], ramesh: ["not_online"] },
      eligible: ["arjun", "meera", "dev", "tara", "rupa"],
    },
  },
  {
    id: "returning-loyal",
    title: "Returning user with a clear favourite by behaviour",
    businessCase: "Users who keep coming back to an astrologer see them first, with an explanation.",
    user: "loyal",
    request: request("loyal", "returning-loyal"),
    expect: {
      segment: "returningUser",
      top: { n: 3, include: ["meera"] },
      reasonsInclude: { meera: ["You've consulted"] },
      signalSign: { meera: { repeatAstrologer: "positive" } },
    },
  },
  {
    id: "favourite-only",
    title: "User who favourited an astrologer but never called",
    businessCase: "Explicit favourites are honoured even without call history.",
    user: "favoriteOnly",
    request: request("favoriteOnly", "favourite-only"),
    expect: {
      segment: "returningUser",
      top: { n: 3, include: ["dev"] },
      reasonsInclude: { dev: ["favourites"] },
    },
  },
  {
    id: "explicit-preferences",
    title: "New user with English + career preferences",
    businessCase: "Onboarding preferences personalise results before any call history exists.",
    user: "englishCareer",
    request: request("englishCareer", "explicit-preferences"),
    expect: {
      reasonsInclude: { meera: ["Specialises in Career"] },
      signalSign: { meera: { languageMatch: "positive", categoryMatch: "positive" } },
      ranksAbove: [["meera", "asha"]],
    },
  },
  {
    id: "budget-user",
    title: "Price-sensitive returning user",
    businessCase: "Users who always pick cheap astrologers see affordable options favoured.",
    user: "budget",
    request: request("budget", "budget-user"),
    expect: {
      segment: "returningUser",
      signalSign: { harpreet: { priceAffinity: "positive" } },
      reasonsInclude: { harpreet: ["You've consulted"] },
    },
  },
  {
    id: "premium-user",
    title: "High-spending returning user",
    businessCase: "Users who pay for premium astrologers aren't pushed toward cheap ones.",
    user: "premium",
    request: request("premium", "premium-user"),
    expect: { segment: "returningUser", top: { n: 3, include: ["arjun"] }, reasonsInclude: { arjun: ["You've consulted"] } },
  },
  {
    id: "lapsed-user",
    title: "User whose only call was five months ago",
    businessCase: "Old history fades: a single stale call doesn't dominate the ranking.",
    user: "lapsed",
    request: request("lapsed", "lapsed-user"),
    expect: { segment: "returningUser", reasonsExclude: { asha: ["You've consulted"] } },
  },
  {
    id: "new-astrologer-exploration",
    title: "Brand-new astrologer gets a chance",
    businessCase: "New astrologers with no data are explored rather than buried.",
    user: "anonymous",
    request: request("anonymous", "new-astrologer-exploration", { context: { languages: ["english"] } }),
    expect: { eligible: ["tara"], explored: ["tara"], signalSign: { tara: { exploration: "positive" } } },
  },
  {
    id: "provider-overexposed",
    title: "Provider B dominating recent top slots",
    businessCase: "Under-exposed providers get a bounded booster and quota urgency; the over-exposed one gets neither.",
    user: "anonymous",
    request: request("anonymous", "provider-overexposed"),
    traffic: "providerB-overexposed",
    expect: {
      signalSign: {
        meera: { providerBooster: "zero", quotaUrgencyBoost: "zero" },
        harpreet: { providerBooster: "zero" },
        arjun: { providerBooster: "positive", quotaUrgencyBoost: "positive" },
        dev: { providerBooster: "positive" },
      },
    },
  },
  {
    id: "booster-respects-relevance",
    title: "Booster withheld from off-topic astrologers",
    businessCase: "Provider optimization never overrides relevance: an under-target provider's astrologer who doesn't speak the requested language gets no boost.",
    user: "anonymous",
    request: request("anonymous", "booster-respects-relevance", { context: { languages: ["tamil"] } }),
    traffic: "providerB-overexposed",
    expect: {
      signalSign: { arjun: { providerBooster: "zero", quotaUrgencyBoost: "zero", languageScore: "zero" } },
      ranksAbove: [["meera", "arjun"]],
    },
  },
  {
    id: "provider-balanced",
    title: "Providers already at target exposure",
    businessCase: "No balancing correction when exposure matches targets.",
    user: "anonymous",
    request: request("anonymous", "provider-balanced"),
    traffic: "balanced",
    expect: { signalSign: { arjun: { providerBooster: "zero" }, meera: { providerBooster: "zero" }, dev: { providerBooster: "zero" } } },
  },
  {
    id: "provider-saturated",
    title: "Under-exposed provider at capacity",
    businessCase: "A provider near capacity gets no extra traffic even if below its target share.",
    user: "anonymous",
    request: request("anonymous", "provider-saturated"),
    traffic: "providerC-saturated",
    expect: { signalSign: { dev: { providerBooster: "zero", quotaUrgencyBoost: "zero", availabilityScore: "positive" }, tara: { providerBooster: "zero" } } },
  },
  {
    id: "frequency-fatigue",
    title: "Same astrologer shown to this session many times",
    businessCase: "Repeated exposure to one viewer is penalized (bounded), so the list stays fresh.",
    user: "anonymous",
    request: request("anonymous", "frequency-fatigue"),
    history: mergeHistory(BASE_HISTORY, viewerImpressions(ASTRO.asha, "scenario-frequency-fatigue", 12)),
    expect: { signalSign: { asha: { frequencyPenalty: "negative" }, arjun: { frequencyPenalty: "zero" } } },
  },
  {
    id: "frequency-exempts-favourites",
    title: "A loyal user keeps seeing their astrologer",
    businessCase: "Fatigue never pushes down a user's own favourite or previous astrologer.",
    user: "loyal",
    request: request("loyal", "frequency-exempts-favourites"),
    history: mergeHistory(BASE_HISTORY, viewerImpressions(ASTRO.meera, "scenario-frequency-exempts-favourites", 12, "user-returning-loyal")),
    expect: { signalSign: { meera: { frequencyPenalty: "zero", repeatAstrologer: "positive" } }, top: { n: 3, include: ["meera"] } },
  },
  {
    id: "specialization-request",
    title: "Tarot reading requested",
    businessCase: "A requested specialization lifts matching experts via categoryScore.",
    user: "anonymous",
    request: request("anonymous", "specialization-request", { context: { specialization: "tarot" } }),
    expect: { signalSign: { tara: { specializationMatch: "positive" }, arjun: { specializationMatch: "zero" } }, reasonsInclude: { tara: ["Tarot expert"] } },
  },
  {
    id: "business-value",
    title: "Strong converter vs weak converter",
    businessCase: "Astrologers who convert and earn more are valued higher, all else comparable.",
    user: "anonymous",
    request: request("anonymous", "business-value", { context: { languages: ["hindi"] } }),
    history: BASE_HISTORY,
    expect: { ranksAbove: [["arjun", "asha"]] },
  },
];

export const scenarioById = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario "${id}"`);
  return s;
};

export const astroId = (k: AstroKey) => ASTRO[k].id;
