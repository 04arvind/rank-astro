import { config } from "@/config";
import { getAnalyticsStore } from "@/lib/analytics";
import { getAstrologerRepository, toPublicAstrologer } from "@/lib/astrologer";
import { logError } from "@/lib/errors";
import { runRanking, userReasons, type RankedCandidate, type RankingRun } from "@/lib/ranking";
import { DAY_MS } from "@/lib/utils/time";
import type { AstrologerProfile } from "@/types/astrologer";
import type { FeedColumn, FeedColumnId, FeedItem, HomeFeed } from "@/types/feed";
import type { RankingContext } from "@/types/ranking";
import { allocate, compose, type Entry } from "./compose";
import { columnCap, countByProvider, PageBudget, providerNudge, providerWeights } from "./providers";
import { similarity } from "./similarity";

/*
 * The home page's four columns, composed from ONE ranking run:
 *
 *   Popular        top of the overall ranking, lightly provider-capped.
 *   Premium        premium-price / high-value astrologers that pass the
 *                  quality gate and aren't offline, in rank + availability
 *                  order within the provider quotas.
 *   Personalized   the user's liked / favourite / consulted astrologers,
 *                  then preference matches, then "similar to" picks last.
 *   Recommended    NOT the top: a banded mix of upper (2nd onwards), mid
 *                  and lower (quality-gated) ranks, nudged toward
 *                  under-exposed providers with spare capacity.
 *
 * Every column draws its provider quotas from one PageBudget built from live
 * provider state (target vs. recent exposure, utilization), so the page as a
 * whole doesn't over-expose the provider with the most supply, and a
 * provider missing from one column is made up in the next. Astrologers
 * appear in one column only unless a column would otherwise run short.
 * Build order (pins → popular → premium → personalized → recommended) sets
 * who gets first claim on an astrologer; display order is fixed separately.
 */

const DISPLAY_ORDER: FeedColumnId[] = ["recommended", "popular", "personalized", "premium"];
const RANK_SPREAD = 0.2;

interface Pick extends Entry {
  c: RankedCandidate;
  highlight?: string;
  related?: boolean;
}

const signals = (c: RankedCandidate) => c.explanation.signals;
const isAvailable = (c: RankedCandidate) =>
  !config.exploration.diversity.providerFloor.excludeStatuses.includes(c.astrologer.availability.status);
const isQualified = (c: RankedCandidate) => signals(c).qualityScore >= config.feed.minQualityScore && isAvailable(c);

function isPremium(c: RankedCandidate): boolean {
  const p = config.feed.premium;
  return (
    c.features.priceBand === 2 ||
    signals(c).businessScore >= p.minBusinessScore ||
    (c.astrologer.tier !== undefined && p.tiers.includes(c.astrologer.tier))
  );
}

function premiumHighlight(c: RankedCandidate): string {
  const a = c.astrologer;
  if (a.tier && config.feed.premium.tiers.includes(a.tier)) return "Top-tier expert";
  if (a.experienceYears !== null && a.experienceYears >= 10) return `${a.experienceYears}+ yrs experience`;
  return "Premium astrologer";
}

interface Taste {
  /** Astrologer id → why it's the user's (pinned in order). */
  mine: Map<string, string>;
  disliked: Set<string>;
  /** Profiles to find similar astrologers to. */
  seeds: AstrologerProfile[];
  hasPreferences: boolean;
}

/** What the user has liked, favourited, consulted or disliked. */
async function tasteOf(run: RankingRun, now: number): Promise<Taste> {
  const { user } = run;
  const p = config.feed.personalized;
  const mine = new Map<string, string>();
  const disliked = new Set<string>();
  const hasPreferences = user.languagePreference.languages.length > 0 || user.categoryPreference.categories.length > 0;
  if (!user.userId) return { mine, disliked, seeds: [], hasPreferences };

  let ratings: { astrologerId: string; rating: number; complaint: boolean; timestamp: number }[] = [];
  try {
    ratings = await getAnalyticsStore().query({
      type: "rating",
      userId: user.userId,
      range: { from: now - p.ratingLookbackDays * DAY_MS, to: now },
    });
  } catch (err) {
    logError(err, { scope: "feed", operation: "ratings" });
  }
  // The latest rating per astrologer is the user's current opinion.
  const latest = new Map<string, (typeof ratings)[number]>();
  for (const r of [...ratings].sort((a, b) => a.timestamp - b.timestamp)) latest.set(r.astrologerId, r);
  const liked: [string, number][] = [];
  for (const [id, r] of latest) {
    if (r.complaint || r.rating <= p.dislikedMaxRating) disliked.add(id);
    else if (r.rating >= p.likedMinRating) liked.push([id, r.rating]);
  }

  const add = (id: string, why: string) => {
    if (!disliked.has(id) && !mine.has(id)) mine.set(id, why);
  };
  for (const id of user.favorites) add(id, "In your favourites");
  for (const [id, rating] of liked.sort((a, b) => b[1] - a[1])) add(id, `You rated ${rating}★`);
  for (const prev of user.previousAstrologers) add(prev.astrologerId, "You consulted before");

  const seeds = mine.size ? await getAstrologerRepository().getByIds([...mine.keys()]) : [];
  return { mine, disliked, seeds, hasPreferences };
}

export interface HomeFeedResult {
  feed: HomeFeed;
  run: RankingRun;
  /** Slots per provider across the page (for logs / impressions). */
  providerMix: ReadonlyMap<string, number>;
}

/**
 * The home page's explicit filters are hard: the engine treats category and
 * language as ranking preferences (so it still returns non-matching and
 * no-data profiles), but a visitor who picks "Career" or "Tamil" expects only
 * astrologers who list it. Uses the request as sent, not the preferences the
 * engine fills in from history. Price and online-only are already hard.
 */
function matchesFilters(c: RankedCandidate, request: RankingContext): boolean {
  const { category, languages } = request.context;
  if (category && !c.astrologer.categories.includes(category)) return false;
  if (languages?.length && !languages.some((l) => c.astrologer.languages.includes(l))) return false;
  return true;
}

export async function buildHomeFeed(request: RankingContext, { now = Date.now() }: { now?: number } = {}): Promise<HomeFeedResult> {
  const run = await runRanking(request, { now });
  // Keep engine order; renumber so ranks (and rank bands) are within the filtered set.
  const ranked = run.ranked.filter((c) => matchesFilters(c, request)).map((c, i) => ({ ...c, rank: i + 1 }));
  const size = config.feed.columnSize;
  const states = run.context.providers;
  // Position in the engine's final order (after its diversity re-rank), 1 → 0, scaled to about a score's spread.
  const rankScore = (c: RankedCandidate) => RANK_SPREAD * (1 - (c.rank - 1) / Math.max(1, ranked.length));
  const budget = new PageBudget(providerWeights(states));
  const used = new Set<string>();
  const taste = await tasteOf(run, now);

  const entry = (c: RankedCandidate, score: number, extra: Partial<Pick> = {}): Pick => ({
    id: c.astrologer.id,
    providerId: c.astrologer.providerId,
    score,
    c,
    ...extra,
  });

  const claim = (picks: Pick[]) => {
    for (const p of picks) used.add(p.id);
    budget.record(picks.map((p) => p.providerId));
    return picks;
  };

  /**
   * Fills up to `n` slots from `pool` under this column's share of the page
   * budget. Never repeats an astrologer from an earlier column: with narrow
   * filters later columns come out short rather than duplicated.
   */
  const fill = (pool: Pick[], n: number, opts: { slack?: number; interleave?: boolean; groupQuota?: Map<string, number> } = {}) => {
    if (n <= 0) return [];
    const fresh = pool.filter((p) => !used.has(p.id));
    const quotas = budget.quotas(n, countByProvider(fresh));
    const caps = new Map([...quotas].map(([id, q]) => [id, Math.min(q + (opts.slack ?? 0), columnCap(id, n))]));
    return claim(compose(fresh, { size: n, providerCaps: caps, interleave: opts.interleave, groupQuota: opts.groupQuota }));
  };

  // 1. The user's own astrologers claim their Personalized slots first. They
  //    are the user's choice, so provider quotas don't apply (but still count).
  const pins = claim(
    ranked
      .filter((c) => taste.mine.has(c.astrologer.id))
      .sort((a, b) => [...taste.mine.keys()].indexOf(a.astrologer.id) - [...taste.mine.keys()].indexOf(b.astrologer.id))
      .slice(0, config.feed.personalized.maxPinned)
      .map((c) => entry(c, 0, { highlight: taste.mine.get(c.astrologer.id) })),
  );

  // 2. Popular: overall ranking order; quotas only cap a provider, with slack.
  const popular = fill(
    ranked.map((c) => entry(c, -c.rank)),
    size,
    { slack: config.feed.providerBalance.popularSlack },
  );

  // 3. Premium: high-value, quality-gated, not offline; score + availability.
  const premium = fill(
    ranked
      .filter((c) => isPremium(c) && isQualified(c))
      .map((c) => entry(c, rankScore(c) + config.feed.premium.availabilityWeight * signals(c).availabilityScore, { highlight: premiumHighlight(c) })),
    size,
  );

  // 4. Personalized: preference matches, then "similar to" picks at the bottom.
  const p = config.feed.personalized;
  const open = size - pins.length;
  const relatedTarget = taste.seeds.length ? Math.round(open * p.relatedShare) : 0;
  const candidates = ranked.filter((c) => !taste.disliked.has(c.astrologer.id) && !taste.mine.has(c.astrologer.id));
  const related: Pick[] = [];
  for (const c of candidates) {
    let best: { sim: number; seed: AstrologerProfile } | null = null;
    for (const seed of taste.seeds) {
      const sim = similarity(c.astrologer, seed);
      if (sim !== null && sim >= p.relatedMinSimilarity && (!best || sim > best.sim)) best = { sim, seed };
    }
    if (best) related.push(entry(c, best.sim + rankScore(c), { related: true, highlight: `Similar to ${best.seed.name}` }));
  }
  const direct = candidates.map((c) => entry(c, signals(c).personalizationScore + rankScore(c)));
  const relatedPicks = fill(related, relatedTarget, { slack: 1 });
  const directPicks = fill(direct, open - relatedPicks.length, { slack: 1 });
  const moreRelated = fill(related, open - relatedPicks.length - directPicks.length, { slack: 1 });
  const personalized = [...pins, ...directPicks, ...relatedPicks, ...moreRelated];

  // 5. Recommended: banded mix below the very top, provider-nudged.
  const r = config.feed.recommended;
  const n = ranked.length;
  const bandOf = (c: RankedCandidate) => {
    const pct = (c.rank - 1) / Math.max(1, n);
    return pct < r.midFrom ? "upper" : pct < r.lowerFrom ? "mid" : "lower";
  };
  const recPool = ranked
    .filter((c) => c.rank > 1 && (bandOf(c) !== "lower" || isQualified(c)))
    .map((c) =>
      entry(c, rankScore(c) + providerNudge(states.get(c.astrologer.providerId)), {
        group: bandOf(c),
        highlight: bandOf(c) === "upper" ? undefined : "Worth discovering",
      }),
    );
  const freshBands = new Map<string, number>();
  for (const e of recPool) if (!used.has(e.id)) freshBands.set(e.group!, (freshBands.get(e.group!) ?? 0) + 1);
  const bandQuota = allocate(size, new Map(Object.entries(r.bands)), freshBands);
  const recommended = fill(recPool, size, { interleave: true, groupQuota: bandQuota });

  const hasHistory = taste.mine.size > 0;
  const meta: Record<FeedColumnId, { title: string; subtitle: string; picks: Pick[] }> = {
    recommended: { title: "Recommended for You", subtitle: "A fresh mix of astrologers worth discovering", picks: recommended },
    popular: { title: "Popular", subtitle: "Top-ranked astrologers right now", picks: popular },
    personalized: {
      title: "Personalized Astro",
      subtitle: hasHistory
        ? "Based on astrologers you've consulted and liked"
        : taste.hasPreferences
          ? "Based on your language and topic preferences"
          : "Consult or rate astrologers to personalise this list",
      picks: personalized,
    },
    premium: { title: "Premium Astrologers", subtitle: "Experienced, high-demand experts", picks: premium },
  };

  const columns: FeedColumn[] = DISPLAY_ORDER.map((id) => ({
    id,
    title: meta[id].title,
    subtitle: meta[id].subtitle,
    items: meta[id].picks.map(
      (pk, i): FeedItem => ({
        rank: pk.c.rank,
        score: pk.c.score,
        astrologer: toPublicAstrologer(pk.c.astrologer),
        reasons: userReasons(pk.c),
        position: i + 1,
        highlight: pk.highlight,
        related: pk.related,
      }),
    ),
  }));

  return { feed: { columns, total: ranked.length }, run, providerMix: budget.counts() };
}
