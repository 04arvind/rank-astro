import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@/config";
import { runRanking, type RankedCandidate } from "@/lib/ranking";
import { thompsonRerank } from "@/lib/ranking/bandit";
import { loadBanditState } from "@/lib/ranking/bandit/policy";
import { finalRerank } from "@/lib/ranking/final/rerank";
import { setRankerArtifact } from "@/lib/ranking/ml";
import { freshPipeline, NOW, request, viewerIn } from "./helpers";

/*
 * Layer 6 (final validation / constraints) and the Layer-5 fairness term.
 */

after(() => {
  delete process.env.BANDIT_MODE;
  setRankerArtifact(undefined);
});

const ids = (xs: RankedCandidate[]) => xs.map((c) => c.astrologer.id);

async function baseRun() {
  await freshPipeline("off");
  return runRanking(request("user-x"), { now: NOW });
}

test("a valid list passes through Layer 6 unchanged", async () => {
  const run = await baseRun();
  const out = finalRerank(run.ranked, run.context);
  assert.deepEqual(ids(out.ranked), ids(run.ranked));
  assert.equal(out.dropped.length, 0);
});

test("duplicates are removed (best position kept) and ranks renumbered", async () => {
  const run = await baseRun();
  const dup = { ...run.ranked[0], rank: 99 };
  const out = finalRerank([...run.ranked, dup], run.context);
  assert.deepEqual(ids(out.ranked), ids(run.ranked));
  assert.deepEqual(out.dropped.map((d) => d.reasons), [["duplicate"]]);
  out.ranked.forEach((c, i) => assert.equal(c.rank, i + 1));
});

test("an astrologer that is no longer eligible (went offline under online-only) is dropped with the reason", async () => {
  const run = await baseRun();
  const online = run.ranked.filter((c) => c.astrologer.availability.status === "online");
  assert.ok(online.length >= 2);
  const wentOffline = { ...online[0], astrologer: { ...online[0].astrologer, availability: { status: "offline" as const, lastActiveAt: null } } };
  const sctx = { ...run.context, ctx: { ...run.context.ctx, filters: { ...run.context.ctx.filters, onlineOnly: true } } };
  const out = finalRerank([wentOffline, ...online.slice(1)], sctx);
  assert.ok(!ids(out.ranked).includes(wentOffline.astrologer.id));
  assert.ok(out.dropped[0].reasons.includes("not_online"));
});

test("constraint repair: a run of one provider beyond the limit is broken up, and a non-finite score goes last", async () => {
  const run = await baseRun();
  const maxRun = config.exploration.diversity.maxConsecutiveSameProvider;
  const byProvider = Map.groupBy(run.ranked, (c) => c.astrologer.providerId);
  const [pid, same] = [...byProvider].sort((a, b) => b[1].length - a[1].length)[0];
  assert.ok(same.length > maxRun, "fixture needs a provider with enough astrologers");
  const nonPersonal = same.filter((c) => c.features.isFavorite !== 1 && !(c.features.userCallsWithAstrologer ?? 0));
  const others = run.ranked.filter((c) => c.astrologer.providerId !== pid);
  const broken = { ...others[0], score: NaN };
  const input = [...nonPersonal.slice(0, maxRun + 1), ...others.slice(1), broken];

  const out = finalRerank(input, run.context);
  const head = out.ranked.slice(0, maxRun + 1).map((c) => c.astrologer.providerId);
  assert.ok(!head.every((p) => p === pid), `still ${maxRun + 1} in a row from ${pid}`);
  assert.ok(out.repaired >= 1);
  assert.equal(out.ranked.at(-1)!.astrologer.id, broken.astrologer.id);
  assert.ok(out.ranked.some((c) => c.adjustments.some((a) => a.stage === "final" && a.note.startsWith("moved up"))));
});

test("Thompson reward gets the fair-exposure lift for under-target providers only", async () => {
  await freshPipeline("live");
  const run = await runRanking(request(viewerIn("treatment")), { now: NOW });
  const providers = [...new Set(run.ranked.map((c) => c.astrologer.providerId))];
  assert.ok(providers.length >= 2);
  const [under, ...rest] = providers;
  const gap = config.ranking.adjustments.providerBooster.saturationGap; // saturates the lift
  const states = new Map(
    providers.map((p) => [p, { ...(run.context.providers.get(p) ?? ({} as never)), providerId: p, gap: p === under ? gap : -0.1 }]),
  );
  const sctx = { ...run.context, providers: states };
  const state = await loadBanditState(run.ranked.map((c) => c.astrologer), sctx.ctx, NOW);
  const { bandit } = thompsonRerank(run.ranked, state, sctx);
  const lift = 1 + config.ranking.bandit.fairness.weight;
  for (const [id, d] of bandit!.decisions) {
    const pid = run.ranked.find((c) => c.astrologer.id === id)!.astrologer.providerId;
    if (pid === under) assert.ok(Math.abs(d.fairness - lift) < 1e-12, `${id} fairness ${d.fairness}`);
    else assert.equal(d.fairness, 1, `${pid} (${rest.join(",")}) is not under target`);
  }
});
