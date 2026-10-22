/**
 * Ranking simulation against the normalized snapshot (or live feeds).
 *
 *   npm run sim:ranking -- [--sessions 500] [--seed 42] [--history events.json] [--save-events] [--report]
 *
 * Replays synthetic browsing sessions through the real engine (lib/ranking)
 * and feeds the outcomes back through lib/analytics, so later sessions see
 * the effect of earlier ones — provider balancing, exploration, and
 * learning from engagement. Everything runs in memory; nothing touches
 * production stores.
 *
 * The user model below is simulation-only: each astrologer gets a hidden
 * "appeal" the engine never sees, and clicks follow a position-bias curve.
 * If ranking learns from outcomes, appeal and exposure should correlate.
 */
import { config } from "@/config";
import { recordCall, recordClicks, recordImpressions, recordRating, getProviderMetrics } from "@/lib/analytics";
import { componentOf, runRanking } from "@/lib/ranking";
import { addFavorite } from "@/lib/user";
import { countBy } from "@/lib/utils/collections";
import { hashUnit, mean } from "@/lib/utils/math";
import { MINUTE_MS } from "@/lib/utils/time";
import type { RankingContext } from "@/types/ranking";
import { args, heading, intArg, main, pct, pick, REPORTS_DIR, rng, stamp, writeJson } from "./_lib/cli";
import { exportEvents, importEvents, loadAstrologers } from "./_lib/data";

const USAGE = `
Usage: npm run sim:ranking -- [options]

  --sessions <n>       Browsing sessions to simulate (default 500)
  --users <n>          Size of the returning-user pool (default 60)
  --returning <0..100> % of sessions from returning users (default 40)
  --page-size <n>      Results shown per session (default 20)
  --seed <n>           RNG seed for reproducible runs (default 42)
  --from-feeds         Normalize provider feeds instead of reading the snapshot
  --history <file>     Preload analytics events (e.g. a previous --save-events file)
  --save-events        Write all events to reports/events-<timestamp>.json
  --report             Write reports/simulation-<timestamp>.json
`;

// ---- simulated user behaviour (not ranking logic) --------------------------
const BASE_CTR = 0.35;
const POSITION_DECAY = 0.8; // click propensity ∝ position^-decay
const CALL_GIVEN_CLICK = 0.45;
const MISSED_CALL_RATE = 0.1;
const RATING_RATE = 0.6;

main("simulate-ranking", async () => {
  const opts = args(USAGE, {
    sessions: { type: "string" },
    users: { type: "string" },
    returning: { type: "string" },
    "page-size": { type: "string" },
    seed: { type: "string" },
    "from-feeds": { type: "boolean" },
    history: { type: "string" },
    "save-events": { type: "boolean" },
    report: { type: "boolean" },
  });
  const sessions = intArg(opts.sessions, 500, "sessions");
  const userPool = Math.max(1, intArg(opts.users, 60, "users"));
  const returningShare = intArg(opts.returning, 40, "returning") / 100;
  const pageSize = Math.max(1, intArg(opts["page-size"], 20, "page-size"));
  const seed = intArg(opts.seed, 42, "seed");
  const r = rng(seed);

  const { astrologers, source } = await loadAstrologers(Boolean(opts["from-feeds"]));
  console.log(`Loaded ${astrologers.length} astrologers from ${source}; seed ${seed}`);
  if (opts.history) console.log("Preloaded history:", await importEvents(opts.history));

  /** Hidden appeal in [0.4, 1.6] — the "true quality" the engine must discover. */
  const appeal = new Map(astrologers.map((a) => [a.id, 0.4 + 1.2 * hashUnit(`${seed}:appeal:${a.id}`)]));
  const byId = new Map(astrologers.map((a) => [a.id, a]));
  const languages = config.catalog.languages.map((l) => l.id);
  const categories = config.catalog.categories.map((c) => c.id);

  // A few returning users have a favourite, to exercise that path.
  for (let u = 0; u < userPool; u += 7) await addFavorite(`sim-user-${u}`, pick(astrologers, r).id);

  const topN = config.business.guardrails.topN;
  const buckets = 4;
  const bucketShares: Record<string, number>[] = Array.from({ length: buckets }, () => ({}));
  const shownTopN = new Map<string, number>();
  let clicks = 0;
  let calls = 0;
  let explorationShown = 0;
  let emptyResults = 0;
  const personalReasons: number[] = [];

  for (let s = 0; s < sessions; s++) {
    const returning = r() < returningShare;
    const userId = returning ? `sim-user-${Math.floor(r() * userPool)}` : undefined;
    const ctx: RankingContext = {
      user: { userId, sessionId: `sim-session-${seed}-${s}` },
      context: {
        languages: r() < 0.6 ? [pick(languages.slice(0, 3), r)] : undefined,
        category: r() < 0.4 ? pick(categories, r) : undefined,
      },
      filters: { onlineOnly: false },
      pagination: { limit: pageSize, offset: 0 },
    };

    const run = await runRanking(ctx);
    const page = run.ranked.slice(0, pageSize);
    if (page.length === 0) {
      emptyResults++;
      continue;
    }

    await recordImpressions(
      page.map((c) => ({
        astrologerId: c.astrologer.id,
        providerId: c.astrologer.providerId,
        position: c.rank,
        sessionId: ctx.user.sessionId,
        userId,
        engineVersion: run.scorer,
        category: ctx.context.category,
      })),
    );

    const bucket = bucketShares[Math.min(buckets - 1, Math.floor((s / sessions) * buckets))];
    for (const c of page.slice(0, topN)) {
      bucket[c.astrologer.providerId] = (bucket[c.astrologer.providerId] ?? 0) + 1;
      shownTopN.set(c.astrologer.id, (shownTopN.get(c.astrologer.id) ?? 0) + 1);
    }
    explorationShown += page.filter((c) => c.isExploration).length;
    if (userId) personalReasons.push(page.filter((c) => (componentOf(c, "repeatAstrologer")?.value ?? 0) > 0).length);

    // At most one click per session: scan the page top-down.
    for (const c of page) {
      const p = BASE_CTR * c.rank ** -POSITION_DECAY * appeal.get(c.astrologer.id)!;
      if (r() >= p) continue;

      clicks++;
      await recordClicks([{ astrologerId: c.astrologer.id, providerId: c.astrologer.providerId, position: c.rank, sessionId: ctx.user.sessionId, userId }]);
      if (r() < CALL_GIVEN_CLICK * Math.min(1, appeal.get(c.astrologer.id)!)) {
        const callerId = userId ?? `sim-anon-${seed}-${s}`;
        const missed = r() < MISSED_CALL_RATE;
        const minutes = missed ? 0 : 3 + Math.floor(r() * 22 * appeal.get(c.astrologer.id)!);
        const endedAt = Date.now() - Math.floor(r() * 30) * MINUTE_MS;
        const callId = `sim-call-${seed}-${s}`;
        await recordCall({
          callId,
          userId: callerId,
          astrologerId: c.astrologer.id,
          providerId: c.astrologer.providerId,
          status: missed ? "missed" : "completed",
          startedAt: endedAt - minutes * MINUTE_MS,
          endedAt,
          pricePerMinute: byId.get(c.astrologer.id)!.pricing.perMinute,
        });
        if (!missed) calls++;
        if (!missed && r() < RATING_RATE) {
          const rating = Math.max(1, Math.min(5, Math.round(2.5 + 1.6 * appeal.get(c.astrologer.id)! + (r() - 0.5))));
          await recordRating({ callId, userId: callerId, astrologerId: c.astrologer.id, providerId: c.astrologer.providerId, rating, complaint: rating <= 2 });
        }
      }
      break;
    }
    if ((s + 1) % Math.max(1, Math.floor(sessions / 10)) === 0) process.stdout.write(`  ${s + 1}/${sessions} sessions\r`);
  }

  // ---- results --------------------------------------------------------------
  heading("Provider share of top-N slots over the run (vs target)");
  const targets = new Map(config.providers.providers.map((p) => [p.id, p.targetShare]));
  const providerIds = [...new Set([...targets.keys(), ...bucketShares.flatMap((b) => Object.keys(b))])];
  const shareRows = providerIds.map((id) => {
    const row: Record<string, string> = { provider: id, target: pct(targets.get(id) ?? null, 0) };
    bucketShares.forEach((b, i) => {
      const total = Object.values(b).reduce((x, y) => x + y, 0);
      row[`Q${i + 1}`] = pct(total ? (b[id] ?? 0) / total : null, 0);
    });
    return row;
  });
  console.table(shareRows);

  heading("Exposure vs hidden appeal");
  const exposure = astrologers.map((a) => ({ id: a.id, appeal: appeal.get(a.id)!, shown: shownTopN.get(a.id) ?? 0 }));
  const rho = spearman(exposure.map((e) => e.appeal), exposure.map((e) => e.shown));
  const total = exposure.reduce((s, e) => s + e.shown, 0);
  const top10Share = [...exposure].sort((a, b) => b.shown - a.shown).slice(0, 10).reduce((s, e) => s + e.shown, 0) / (total || 1);
  const coverage = exposure.filter((e) => e.shown > 0).length / (astrologers.length || 1);
  console.log(`Spearman(appeal, top-${topN} exposure): ${rho.toFixed(3)}  (↑ = ranking is learning from outcomes)`);
  console.log(`Top-10 astrologers' share of top-${topN} slots: ${pct(top10Share)}  ·  astrologers ever in top ${topN}: ${pct(coverage)}`);

  heading("Engagement");
  const impressions = sessions - emptyResults;
  console.log(`Sessions ${sessions} (empty ${emptyResults}) · clicks ${clicks} (${pct(clicks / (impressions || 1))}/session) · completed calls ${calls}`);
  console.log(`Exploration slots shown: ${explorationShown} (${pct(explorationShown / ((impressions || 1) * pageSize))} of results)`);
  console.log(`Returning sessions with personal (repeat/favourite) results: avg ${mean(personalReasons)?.toFixed(2) ?? "—"} per page`);

  const providerMetrics = await getProviderMetrics({ window: "24h" });
  heading("Provider metrics (lib/analytics, last 24h)");
  console.table(
    providerMetrics.map((m) => ({
      provider: m.providerId,
      impressions: m.impressions,
      exposure: pct(m.exposureShare),
      target: pct(m.targetShare ?? null, 0),
      ctr: pct(m.ctr),
      conversion: pct(m.conversionRate),
      calls: m.completedCalls,
      revenue: Math.round(m.grossRevenue),
      peakUtil: pct(m.peakUtilization),
    })),
  );

  const events = await exportEvents();
  if (opts["save-events"]) {
    const file = await writeJson(`${REPORTS_DIR}/events-${stamp()}.json`, { seed, generatedAt: new Date().toISOString(), events });
    console.log(`\nSaved ${events.length} events → ${file}`);
  }
  if (opts.report) {
    const file = await writeJson(`${REPORTS_DIR}/simulation-${stamp()}.json`, {
      generatedAt: new Date().toISOString(),
      params: { sessions, userPool, returningShare, pageSize, seed, source },
      providerShareByQuarter: shareRows,
      learning: { spearmanAppealExposure: rho, top10Concentration: top10Share, coverage },
      engagement: { clicks, calls, emptyResults, explorationShown },
      eventsByType: Object.fromEntries(countBy(events, (e) => e.type)),
      providerMetrics,
    });
    console.log(`Report → ${file}`);
  }
});

/** Spearman rank correlation (average ranks for ties). */
function spearman(xs: number[], ys: number[]): number {
  const ranks = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return out;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
