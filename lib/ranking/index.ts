import { config } from "@/config";
import { getAnalyticsStore } from "@/lib/analytics";
import { toPublicAstrologer } from "@/lib/astrologer";
import { getExplicitPreferences, getFavorites, getUserProfile } from "@/lib/user";
import type {
  CandidateDebug,
  EngineInfo,
  PipelineLayerKey,
  PipelineTrace,
  RankingContext,
  RankingDebugRequest,
  RankingDebugResult,
  RankingResult,
} from "@/types/ranking";
import type { BanditContext } from "./bandit/policy";
import { contributionMap, explainRank, userReasons } from "./explanation";
import { featureRow, type FeatureRow } from "./ml/features";
import { runRanking, type RankingRun, type RunOptions } from "./rank";
import { createWeightedScorer, type Scorer } from "./score";

/** Server-only extras on a rank() result; never part of the API response. */
export interface RankServerContext {
  /** Thompson samples, for the exposure log. */
  bandit?: BanditContext;
  /** Feature rows of the returned items, for the learned ranker's training log. */
  trainingRows?: ReadonlyMap<string, FeatureRow>;
  /** Personalised request context the run used (category/segment for logs). */
  category?: string;
  segment?: string;
}

/**
 * The single entry point the API layer talks to. Swap implementations
 * (rule-based, ML, blended, test fake) without touching app/api.
 * Performance data comes from lib/analytics; the engine only consumes it.
 */
export interface RankingEngine {
  rank(ctx: RankingContext): Promise<RankingResult & RankServerContext>;
  debug(req: RankingDebugRequest): Promise<RankingDebugResult>;
}

function thompsonOf(b: BanditContext | undefined, astrologerId: string): CandidateDebug["thompson"] {
  const d = b?.decisions.get(astrologerId);
  if (!b || !d) return undefined;
  const p = d.posterior;
  return { layer2Rank: d.layer2Rank, sample: d.sample, posteriorMean: p.mean, priorMean: p.priorMean, trials: p.trials, successes: p.successes, reward: d.reward, variant: b.variant, mode: b.mode, fairness: d.fairness };
}

/** astrologerId → its position and score after each layer. */
function layerPositions(trace: PipelineTrace | undefined): Map<string, CandidateDebug["layers"]> {
  const out = new Map<string, NonNullable<CandidateDebug["layers"]>>();
  for (const layer of trace?.layers ?? []) {
    for (const e of layer.entries) {
      const m = out.get(e.astrologerId) ?? {};
      m[layer.key as PipelineLayerKey] = { rank: e.rank, score: e.score };
      out.set(e.astrologerId, m);
    }
  }
  return out;
}

const g = globalThis as unknown as { __rankingRuns?: Map<string, { at: number; run: Promise<RankingRun> }> };
const stableRuns = () => (g.__rankingRuns ??= new Map());

/** Drops every reused ranking run (tests, or after a change that must show immediately). */
export function resetRankingRuns(): void {
  g.__rankingRuns?.clear();
}

/**
 * Whether the visitor has done anything beyond viewing lists: a click, call or
 * rating (by user or session), or a saved profile, preferences or favourite.
 * Impressions alone do not count, so a first visit stays on the global order.
 */
async function hasActivity({ userId, sessionId }: RankingContext["user"]): Promise<boolean> {
  if (!userId && !sessionId) return false;
  const store = getAnalyticsStore();
  const range = { from: 0, to: Date.now() };
  const viewers: { userId?: string; sessionId?: string }[] = [];
  if (userId) viewers.push({ userId });
  if (sessionId) viewers.push({ sessionId });
  const checks: Promise<boolean>[] = viewers.flatMap((viewer) =>
    (["click", "call", "rating"] as const).map((type) => store.query({ type, range, ...viewer }).then((e) => e.length > 0)),
  );
  if (userId) {
    checks.push(
      getUserProfile(userId).then(Boolean),
      getExplicitPreferences(userId).then(Boolean),
      getFavorites(userId).then((f) => f.length > 0),
    );
  }
  return (await Promise.all(checks)).some(Boolean);
}

/** Builds an engine around any Scorer — the weighted-score model by default. */
export function createRankingEngine(scorer: Scorer = createWeightedScorer(), options: Omit<RunOptions, "scorer"> = {}): RankingEngine {
  const engine: EngineInfo = { name: scorer.name, version: config.ranking.engine.version };

  /*
   * One computed run per visitor + filter set, reused for stableListSeconds.
   * Every served list records impressions and bandit exposures after the
   * response, which changes the next computation (viewer fatigue, posteriors);
   * without this, the astrologers page, a refresh and the admin dashboard
   * would each rank a slightly different state. Runs are traced so the
   * dashboard can reuse the very run the page was served from.
   */
  // On globalThis: the admin page and the API routes may load separate copies of this module.
  const runs = stableRuns();
  const MAX_RUNS = 1000;
  const stableRun = (ctx: RankingContext, astrologerIds?: readonly string[]): Promise<RankingRun> => {
    const ttl = config.ranking.stableListSeconds * 1000;
    const fresh = () => runRanking(ctx, { ...options, scorer, astrologerIds, trace: true });
    if (ttl <= 0) return fresh();
    const now = Date.now();
    const key = JSON.stringify([scorer.name, ctx.user.userId ?? ctx.user.sessionId ?? null, ctx.context, ctx.filters, astrologerIds ?? null]);
    const hit = runs.get(key);
    if (hit && now - hit.at < ttl) return hit.run;
    const run = fresh().catch((err: unknown) => {
      runs.delete(key); // never cache a failure
      throw err;
    });
    runs.delete(key);
    runs.set(key, { at: now, run });
    for (const [k, v] of runs) if (runs.size > MAX_RUNS || now - v.at >= ttl) runs.delete(k);
    return run;
  };

  return {
    async rank(ctx) {
      // No activity yet: serve the same global run as the admin ranking list (no viewer id).
      const run = await stableRun((await hasActivity(ctx.user)) ? ctx : { ...ctx, user: {} });
      const { offset, limit } = ctx.pagination;
      const page = run.ranked.slice(offset, offset + limit);
      return {
        items: page.map((c) => ({
          rank: c.rank,
          score: c.score,
          astrologer: toPublicAstrologer(c.astrologer),
          reasons: userReasons(c),
        })),
        total: run.ranked.length,
        engine,
        bandit: run.context.bandit,
        trainingRows: new Map(page.map((c) => [c.astrologer.id, featureRow(c)])),
        category: run.context.ctx.context.category,
        segment: run.user.segment,
      };
    },

    async debug(req) {
      const { astrologerIds, ...ctx } = req;
      // Same viewer rule as rank(): no activity yet → the global run, so debug shows what that viewer was served.
      const run = await stableRun((await hasActivity(ctx.user ?? {})) ? ctx : { ...ctx, user: {} }, astrologerIds);
      const layers = layerPositions(run.pipeline);
      const ranked: CandidateDebug[] = run.ranked.map((c) => ({
        astrologerId: c.astrologer.id,
        providerId: c.astrologer.providerId,
        eligible: true,
        finalScore: c.score,
        signals: contributionMap(c),
        rank: c.rank,
        scoreRank: c.scoreRank,
        layer2Rank: c.layer2Rank ?? c.rank,
        astrologer: toPublicAstrologer(c.astrologer),
        breakdown: c.explanation,
        adjustmentsNotes: c.adjustments.map((a) => `${a.stage}: ${a.note}`),
        isExploration: c.isExploration,
        // Only Thompson-sampling picks (slots firstSlot..slots, i.e. 3–4) are shown as Thompson recommendations.
        thompson: c.slot === "bandit" ? thompsonOf(run.context.bandit, c.astrologer.id) : undefined,
        ml: c.ml,
        layers: layers.get(c.astrologer.id),
        explanation: explainRank(c),
      }));
      const excluded: CandidateDebug[] = run.excluded.map((e) => ({
        astrologerId: e.astrologer.id,
        providerId: e.astrologer.providerId,
        eligible: false,
        exclusionReason: e.reasons.join(", "),
        finalScore: 0,
        signals: {},
        astrologer: toPublicAstrologer(e.astrologer),
      }));
      // Removed at Layer 6 (duplicates are already listed once, above).
      const listed = new Set([...ranked, ...excluded].map((c) => c.astrologerId));
      const dropped: CandidateDebug[] = (run.finalDropped ?? [])
        .filter((d) => !listed.has(d.candidate.astrologer.id))
        .map((d) => ({
          astrologerId: d.candidate.astrologer.id,
          providerId: d.candidate.astrologer.providerId,
          eligible: false,
          exclusionReason: `final: ${d.reasons.join(", ")}`,
          finalScore: d.candidate.score,
          signals: contributionMap(d.candidate),
          astrologer: toPublicAstrologer(d.candidate.astrologer),
          breakdown: d.candidate.explanation,
          layers: layers.get(d.candidate.astrologer.id),
        }));
      return { candidates: [...ranked, ...excluded, ...dropped], engine, pipeline: run.pipeline };
    },
  };
}

let engine: RankingEngine = createRankingEngine();

export function getRankingEngine(): RankingEngine {
  return engine;
}

export function setRankingEngine(next: RankingEngine): void {
  engine = next;
}

export { runRanking, type RankingRun, type RunOptions } from "./rank";
export { createBlendedScorer, createRuleBasedScorer, createWeightedScorer, type ModelScorer, type Scorer } from "./score";
export { SIGNAL_REGISTRY } from "./signals";
export { getProviderStates, resetProviderStates } from "./provider/providerDistribution";
export { componentOf, contributionMap, explainRank, userReasons } from "./explanation";
export { LAYERS as PIPELINE_LAYERS } from "./pipeline";
export type * from "./types";
