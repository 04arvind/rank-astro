import { config } from "@/config";
import { getAstrologerMetrics, getExposureSnapshot, toRange, type ExposureSnapshot } from "@/lib/analytics";
import {
  generateCandidates,
  getAstrologerRepository,
  InMemoryAstrologerRepository,
  prepareFeatures,
  type AstrologerRepository,
  type ExcludedCandidate,
} from "@/lib/astrologer";
import { fetchAvailability } from "@/lib/providers";
import { isAppError, logError, RankingError, type RankingStage } from "@/lib/errors";
import { anonymousUserSignals, getUserSignals } from "@/lib/user";
import type { AstrologerProfile } from "@/types/astrologer";
import type { PipelineTrace, RankingContext } from "@/types/ranking";
import { loadBanditState } from "./bandit/policy";
import { thompsonRerank } from "./bandit/rerank";
import { diversify } from "./exploration/diversity";
import { reservePremiumSlots } from "./business/premiumSlots";
import { placeExploration } from "./exploration/explorationScore";
import { finalRerank, type FinalDrop, type FinalResult } from "./final/rerank";
import type { RankerStatus } from "./ml/model";
import { mlRerank, type MlLayerResult } from "./ml/rerank";
import { PipelineRecorder, sameOrder, since } from "./pipeline";
import { getProviderStates } from "./provider/providerDistribution";
import { quotaPeriod } from "./provider/quotaUrgency";
import { createWeightedScorer, type Scorer } from "./score";
import type { RankedCandidate, SignalContext, UserContext } from "./types";

export interface RankingRun {
  ranked: RankedCandidate[];
  excluded: ExcludedCandidate[];
  /** Eligible astrologers dropped by the candidate cap. */
  truncated: number;
  user: UserContext;
  scorer: string;
  /** Request-level inputs the run scored with (personalised context, provider states, exposure). */
  context: SignalContext;
  /** Layer-4 learned ranker status (active, or why it fell back). */
  ml?: RankerStatus;
  /** Removed by Layer 6 (duplicates, failed revalidation). */
  finalDropped?: FinalDrop[];
  /** Layer-by-layer snapshots; only when RunOptions.trace is set. */
  pipeline?: PipelineTrace;
}

export interface RunOptions {
  scorer?: Scorer;
  repository?: AstrologerRepository;
  /** Limit the run to these astrologers (debug tooling). */
  astrologerIds?: readonly string[];
  now?: number;
  /** Record the list after every layer (admin pipeline view). */
  trace?: boolean;
}

const defaultScorer = createWeightedScorer();

const emptyExposure = (): ExposureSnapshot => ({ byAstrologer: new Map(), recentTotal: 0, period: { topNTotal: 0, providerShare: new Map() } });

/** Runs a required stage; unexpected errors become RankingError(stage). */
async function required<T>(stage: RankingStage, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new RankingError(stage, err instanceof Error ? err.message : String(err), { cause: err });
  }
}

/**
 * Runs an optional stage; on failure logs and returns a neutral fallback so
 * a broken dependency (analytics, user store) degrades ranking instead of
 * failing it.
 */
async function optional<T>(stage: RankingStage, fn: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logError(new RankingError(stage, "stage failed; using fallback", { cause: err }), { scope: "ranking" });
    return fallback();
  }
}

/**
 * Fills request gaps from the user's own preferences: no languages asked ->
 * the user's preferred languages; no category -> their first explicit one.
 * Request values always win.
 */
function personalise(ctx: RankingContext, user: UserContext): RankingContext {
  const languages = ctx.context.languages?.length ? ctx.context.languages : user.languagePreference.languages;
  const category = ctx.context.category ?? user.categoryPreference.categories[0];
  return { ...ctx, context: { ...ctx.context, languages: languages.length ? languages : undefined, category } };
}

/** Overlays live provider availability onto stored profiles. */
async function withLiveAvailability(pool: AstrologerProfile[], now: number): Promise<AstrologerProfile[]> {
  const live = await fetchAvailability(pool, now);
  if (live.size === 0) return pool;
  return pool.map((a) => {
    const update = live.get(a.id);
    return update ? { ...a, availability: update } : a;
  });
}

/**
 * The full ranking pipeline (layers as named in lib/ranking/pipeline.ts):
 *   load pool → live availability → analytics metrics & exposure → user
 *   signals → personalised context →
 *   L1 eligibility (+ retrieval cap) → features → provider + bandit state →
 *   L2 business scores →
 *   L3 diversity/guardrail ordering (the learned ranker's shortlist) →
 *   L4 learned ranker (XGBoost LambdaMART; passthrough without a qualified model) →
 *   L5 exploration slots, then Thompson sampling of the top slots (bandit/rerank.ts) →
 *   L6 revalidation, dedupe, constraint repair, renumbering (final/rerank.ts).
 * Loading, L1–L3 and exploration slots are required (RankingError); the
 * learned ranker, Thompson sampling and L6 fall back to the previous order.
 * Returns every eligible candidate in final order with its breakdown.
 */
export async function runRanking(request: RankingContext, options: RunOptions = {}): Promise<RankingRun> {
  const now = options.now ?? Date.now();
  const repo = options.repository ?? getAstrologerRepository();
  const scorer = options.scorer ?? defaultScorer;

  const stored = await required("load", () =>
    options.astrologerIds ? repo.getByIds(options.astrologerIds) : repo.list(),
  );
  const period = quotaPeriod(now);
  const [pool, metrics, user, exposure] = await Promise.all([
    optional("availability", () => withLiveAvailability(stored, now), () => stored),
    optional(
      "metrics",
      () => getAstrologerMetrics({ window: toRange(config.ranking.metricsWindow, now), astrologerIds: stored.map((a) => a.id) }),
      () => new Map(),
    ),
    optional("user", () => getUserSignals(request.user.userId, { now, repository: repo }), anonymousUserSignals),
    optional(
      "metrics",
      () =>
        getExposureSnapshot({
          recent: { from: now - config.ranking.adjustments.frequencyPenalty.windowHours * 3_600_000, to: now },
          period: { from: period.start, to: now },
          topN: config.providers.utilization.topN,
          userId: request.user.userId,
          sessionId: request.user.sessionId,
        }),
      emptyExposure,
    ),
  ]);

  const ctx = personalise(request, user);
  const trace = new PipelineRecorder(options.trace ?? false);

  // Layer 1 — eligibility (the retrieval cap applied alongside it is reported under Layer 3).
  let t0 = performance.now();
  const { candidates, excluded, truncated, truncatedIds = [] } = await required("candidates", () =>
    generateCandidates(ctx, { repository: new InMemoryAstrologerRepository(pool), metrics, now }),
  );
  trace.add("eligibility", {
    list: candidates.map((astrologer) => ({ astrologer })),
    inputCount: pool.length,
    filtered: excluded.map((e) => ({ astrologerId: e.astrologer.id, providerId: e.astrologer.providerId, reasons: e.reasons })),
    status: excluded.length ? "applied" : "passthrough",
    durationMs: since(t0),
    details: { pool: pool.length, eligible: candidates.length + truncated, excluded: excluded.length },
  });

  const features = await required("features", () => prepareFeatures(candidates, { ctx, metrics, user, now }));
  // After eligibility, so targets are shared only among providers that can serve this request.
  const [providers, bandit] = await Promise.all([
    optional(
      "providers",
      () => getProviderStates(now, new Set(candidates.map((c) => c.providerId)), pool),
      () => new Map(),
    ),
    // Thompson state (mode, posteriors) for eligible candidates; failure keeps the pre-bandit order.
    optional("bandit", () => loadBanditState(candidates, ctx, now), () => undefined),
  ]);

  const sctx: SignalContext = {
    ctx,
    user,
    providers,
    exposure,
    now,
    periodElapsed: period.elapsed,
    totalImpressions: features.reduce((s, f) => s + (f.features.impressions ?? 0), 0),
    candidateCount: candidates.length,
  };

  // Layer 2 — business ranking.
  t0 = performance.now();
  const scored = await required("scoring", () =>
    scorer.score(
      candidates.map((astrologer, i) => ({ astrologer, features: features[i].features })),
      sctx,
    ),
  );
  const byScore = await required("rerank", (): RankedCandidate[] =>
    scored
      .sort((a, b) => b.score - a.score || a.astrologer.id.localeCompare(b.astrologer.id))
      .map((c, i) => ({ ...c, rank: i + 1, scoreRank: i + 1, adjustments: [], isExploration: false })),
  );
  trace.add("business", {
    list: byScore,
    score: (c) => c.score,
    inputCount: candidates.length,
    status: "applied",
    durationMs: since(t0),
    details: { scorer: scorer.name, segment: user.segment },
  });

  // Layer 3 — candidate generation: diversity and guardrails over the scored list; its top is the ML shortlist.
  t0 = performance.now();
  const diversified = await required("rerank", () => diversify(byScore, sctx));
  const byId = new Map(pool.map((a) => [a.id, a]));
  trace.add("candidates", {
    list: diversified,
    score: (c) => c.score,
    inputCount: byScore.length + truncated,
    filtered: truncatedIds.map((id) => ({
      astrologerId: id,
      providerId: byId.get(id)?.providerId ?? "",
      reasons: [`retrieval cap (${config.ranking.pagination.maxCandidates} candidates)`],
    })),
    status: truncated > 0 || !sameOrder(byScore, diversified) ? "applied" : "passthrough",
    durationMs: since(t0),
    details: { retrievalCap: config.ranking.pagination.maxCandidates, truncated, mlShortlist: Math.min(config.ranking.ml.shortlistSize, diversified.length) },
  });

  // Layer 4 — learned ranker; any failure keeps the Layer-3 order.
  t0 = performance.now();
  let l4: MlLayerResult;
  try {
    l4 = await mlRerank(diversified, now);
  } catch (err) {
    logError(new RankingError("ml", "learned ranker failed; keeping the Layer-3 order", { cause: err }), { scope: "ranking" });
    l4 = { ranked: diversified, scored: 0, reordered: false, status: { mode: "live", state: "error", reason: err instanceof Error ? err.message : String(err), source: "runtime" } };
  }
  trace.add("ml", {
    list: l4.ranked,
    score: (c) => c.orderScore ?? c.score,
    inputCount: diversified.length,
    status: l4.reordered ? "applied" : l4.status.state === "active" ? "passthrough" : "fallback",
    note: l4.status.state === "active" ? `${l4.status.mode}: ${l4.status.reason}` : `fallback to Layer 3 — ${l4.status.reason}`,
    durationMs: since(t0),
    details: {
      mode: l4.status.mode,
      state: l4.status.state,
      scored: l4.scored,
      blendWeight: config.ranking.ml.blendWeight,
      model: l4.status.model ? `${l4.status.model.name}@${l4.status.model.version}` : null,
    },
  });

  // Layer 5 — exploration slots, premium slots 1–2, then Thompson sampling assigns slots 3–4; scores stay as Layer 2 set them.
  t0 = performance.now();
  const exploredSlots = await required("rerank", () => placeExploration(l4.ranked, sctx));
  let withPremium = exploredSlots;
  try {
    withPremium = reservePremiumSlots(exploredSlots, sctx);
  } catch (err) {
    logError(new RankingError("rerank", "premium slots failed; keeping the exploration order", { cause: err }), { scope: "ranking" });
  }
  const ranked = withPremium.map((c, i) => ({ ...c, rank: i + 1 }));
  let layer5: ReturnType<typeof thompsonRerank> = { ranked };
  try {
    layer5 = thompsonRerank(ranked, bandit, sctx);
  } catch (err) {
    logError(new RankingError("bandit", "Thompson re-rank failed; keeping the pre-bandit order", { cause: err }), { scope: "ranking" });
  }
  const explored = layer5.ranked.map((c, i) => ({ ...c, rank: i + 1 }));
  const banditMoved = explored.filter((c) => c.layer2Rank !== undefined && c.rank !== c.layer2Rank).length;
  const explorationSlots = explored.filter((c) => c.isExploration).length;
  const premiumSlots = explored.filter((c) => c.slot === "premium").length;
  const premiumMoved = !sameOrder(exploredSlots, withPremium);
  const b = layer5.bandit;
  const { firstSlot, slots: lastSlot } = config.ranking.bandit;
  trace.add("exploration", {
    list: explored,
    score: (c) => c.orderScore ?? c.score,
    inputCount: l4.ranked.length,
    status: banditMoved > 0 || explorationSlots > 0 || premiumMoved ? "applied" : b ? "passthrough" : "fallback",
    note: !b
      ? "Thompson sampling off or unavailable — exploration slots only"
      : b.mode === "shadow"
        ? "shadow mode: samples drawn and logged, order unchanged"
        : b.variant === "control"
          ? "holdout viewer: pre-bandit order"
          : `premium slots 1–${firstSlot - 1}, Thompson sampling assigned slots ${firstSlot}–${lastSlot}`,
    durationMs: since(t0),
    details: {
      premiumSlots,
      explorationSlots,
      banditMode: b?.mode ?? "off",
      variant: b?.variant ?? null,
      context: b?.context ?? null,
      sampled: b?.decisions.size ?? 0,
      banditSlots: explored.filter((c) => c.slot === "bandit").length,
      moved: banditMoved,
    },
  });

  // Layer 6 — final validation and constraints; failure serves the Layer-5 order.
  t0 = performance.now();
  let layer6: FinalResult = { ranked: explored, dropped: [], repaired: 0, relaxed: {} };
  let finalFailed: string | undefined;
  try {
    layer6 = finalRerank(explored, sctx, metrics);
  } catch (err) {
    finalFailed = err instanceof Error ? err.message : String(err);
    logError(new RankingError("final", "final re-rank failed; serving the Layer-5 order", { cause: err }), { scope: "ranking" });
  }
  const final = layer6.ranked.map((c, i) => ({ ...c, rank: i + 1 }));
  const relaxed = Object.keys(layer6.relaxed);
  trace.add("final", {
    list: final,
    score: (c) => c.orderScore ?? c.score,
    inputCount: explored.length,
    filtered: layer6.dropped.map((d) => ({ astrologerId: d.candidate.astrologer.id, providerId: d.candidate.astrologer.providerId, reasons: d.reasons })),
    status: finalFailed ? "fallback" : layer6.dropped.length || !sameOrder(explored, final) ? "applied" : "passthrough",
    note: finalFailed ? `fallback to Layer 5 — ${finalFailed}` : relaxed.length ? `relaxed, no alternative: ${relaxed.join("; ")}` : undefined,
    durationMs: since(t0),
    details: { dropped: layer6.dropped.length, repaired: layer6.repaired },
  });

  const pipeline = trace.trace();
  if (pipeline && process.env.RANKING_TRACE_LOG === "1") {
    console.info(`[ranking] pipeline ${pipeline.totalMs}ms ${pipeline.layers.map((l) => `L${l.layer}:${l.status}(${l.inputCount}→${l.outputCount})`).join(" ")}`);
  }

  return {
    ranked: final,
    excluded,
    truncated,
    user,
    scorer: scorer.name,
    context: { ...sctx, bandit: layer5.bandit },
    ml: l4.status,
    finalDropped: layer6.dropped,
    pipeline,
  };
}
