import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRankingEngine, runRanking } from "@/lib/ranking";
import { setRankerArtifact } from "@/lib/ranking/ml";
import type { PipelineLayerKey } from "@/types/ranking";
import { freshPipeline, NOW, request, viewerIn } from "./helpers";

/*
 * The six-layer pipeline: every layer is traced in order, the trace agrees
 * with what is served, and without a learned model the result is exactly
 * the pre-existing ranking.
 */

after(() => {
  delete process.env.BANDIT_MODE;
  setRankerArtifact(undefined);
});

const KEYS: PipelineLayerKey[] = ["eligibility", "business", "candidates", "ml", "exploration", "final"];
const ids = (xs: { astrologer: { id: string } }[]) => xs.map((c) => c.astrologer.id);

test("debug runs trace all six layers in order, consistent with the final list", async () => {
  await freshPipeline("live");
  const run = await runRanking(request(viewerIn("treatment")), { now: NOW, trace: true });
  const layers = run.pipeline!.layers;
  assert.deepEqual(layers.map((l) => l.key), KEYS);
  assert.deepEqual(layers.map((l) => l.layer), [1, 2, 3, 4, 5, 6]);

  const [l1, l2, l3, , , l6] = layers;
  assert.equal(l1.inputCount, l1.outputCount + l1.filtered.length, "eligible + excluded = pool");
  assert.deepEqual(new Set(l1.filtered.map((f) => f.astrologerId)), new Set(run.excluded.map((e) => e.astrologer.id)));
  assert.ok(l1.filtered.every((f) => f.reasons.length > 0), "every exclusion has a reason");

  // Layer 2 is pure score order.
  for (let i = 1; i < l2.entries.length; i++) assert.ok(l2.entries[i - 1].score! >= l2.entries[i].score!);
  assert.equal(l3.outputCount, l2.outputCount);

  // Layer 6 is what's served.
  assert.deepEqual(l6.entries.map((e) => e.astrologerId), ids(run.ranked));
  l6.entries.forEach((e, i) => assert.equal(e.rank, i + 1));
  for (const l of layers) assert.ok(Number.isFinite(l.durationMs) && l.durationMs >= 0);
});

test("without a model, Layer 4 falls back with a reason and the served order is unchanged", async () => {
  await freshPipeline("live");
  const v = viewerIn("treatment");
  const traced = await runRanking(request(v), { now: NOW, trace: true });
  const ml = traced.pipeline!.layers.find((l) => l.key === "ml")!;
  const l3 = traced.pipeline!.layers.find((l) => l.key === "candidates")!;
  assert.equal(ml.status, "fallback");
  assert.match(ml.note!, /no model/);
  assert.deepEqual(ml.entries.map((e) => e.astrologerId), l3.entries.map((e) => e.astrologerId));
  assert.ok(traced.ranked.every((c) => c.orderScore === undefined && c.ml === undefined));

  // Tracing is observation only.
  const plain = await runRanking(request(v), { now: NOW });
  assert.equal(plain.pipeline, undefined);
  assert.deepEqual(ids(plain.ranked), ids(traced.ranked));
});

test("Layer-2 business pillars add up to totalScore for every candidate", async () => {
  await freshPipeline("off", { users: ["favoriteOnly"] });
  const run = await runRanking(request("user-favourite", { category: "career", languages: ["hindi"] }), { now: NOW });
  assert.ok(run.ranked.length > 0);
  for (const c of run.ranked) {
    const p = c.explanation.pillars!;
    const sum = Object.values(p).reduce((s, x) => s + x.contribution, 0);
    assert.ok(Math.abs(sum - c.explanation.totalScore) < 1e-9, `${c.astrologer.id}: pillars ${sum} ≠ total ${c.explanation.totalScore}`);
    assert.ok(p.quality.value === null || (p.quality.value >= 0 && p.quality.value <= 1));
  }
  // Business factors are all present somewhere in the list.
  const any = (name: keyof NonNullable<(typeof run.ranked)[number]["explanation"]["pillars"]>) => run.ranked.some((c) => c.explanation.pillars![name].contribution !== 0);
  for (const name of ["bookingProbability", "profit", "quality", "personalization", "availability", "exposureFairness"] as const) assert.ok(any(name), `${name} never contributes`);
});

test("engine.debug exposes the trace, per-candidate layer positions, and keeps the debug shape", async () => {
  await freshPipeline("live");
  const result = await createRankingEngine().debug(request(viewerIn("treatment")));
  assert.equal(result.pipeline?.layers.length, 6);
  const ranked = result.candidates.filter((c) => c.eligible);
  assert.ok(ranked.length > 0);
  for (const c of ranked) {
    assert.equal(c.layers?.final?.rank, c.rank, "final layer position = served rank");
    assert.equal(c.layers?.business?.rank, c.scoreRank, "business layer position = score rank");
    assert.ok(c.breakdown?.pillars);
  }
  assert.ok(result.candidates.filter((c) => !c.eligible).every((c) => c.exclusionReason));
});

test("the astrologers page and the admin dashboard show the same order, even after the page's impressions are logged", async () => {
  await freshPipeline("live");
  const { recordImpressions } = await import("@/lib/analytics");
  const { recordServed } = await import("@/lib/ranking/bandit");
  const engine = createRankingEngine();
  const v = viewerIn("treatment");
  const page = { ...request(v), pagination: { limit: 100, offset: 0 } };
  const served = await engine.rank(page);
  // What the rank route records after responding: impressions (viewer fatigue) and bandit exposures (posteriors).
  await recordImpressions(served.items.map((i) => ({ astrologerId: i.astrologer.id, providerId: i.astrologer.providerId, position: i.rank, userId: v, sessionId: page.user.sessionId })));
  await recordServed({ bandit: served.bandit, surface: "rank", user: page.user, items: served.items.map((i) => ({ astrologerId: i.astrologer.id, providerId: i.astrologer.providerId, position: i.rank })) });

  const dashboard = await engine.debug({ ...request(v), user: { userId: v } });
  const dashOrder = dashboard.candidates.filter((c) => c.eligible).sort((a, b) => a.rank! - b.rank!).map((c) => c.astrologerId);
  assert.deepEqual(dashOrder, served.items.map((i) => i.astrologer.id));
  assert.deepEqual((await engine.rank(page)).items.map((i) => i.astrologer.id), dashOrder, "a refresh keeps the order");
});

test("engine.rank returns feature rows for exactly the served page (server-only)", async () => {
  await freshPipeline("off");
  const ctx = { ...request("user-x"), pagination: { limit: 3, offset: 1 } };
  const result = await createRankingEngine().rank(ctx);
  assert.equal(result.items.length, 3);
  assert.deepEqual([...result.trainingRows!.keys()], result.items.map((i) => i.astrologer.id));
});
