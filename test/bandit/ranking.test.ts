import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@/config";
import { runRanking, type RankedCandidate } from "@/lib/ranking";
import { InMemoryBanditStore, resetBanditCache, resolveMode, setBanditStore, setModeFlag } from "@/lib/ranking/bandit";
import { astrologerArmId } from "@/lib/ranking/bandit/posterior";
import { ANY_CONTEXT } from "@/lib/ranking/bandit/types";
import { HOUR_MS } from "@/lib/utils/time";
import { ASTRO, freshBandit, NOW, request, treatmentViewers, viewerIn } from "./helpers";

/*
 * Layer 3 re-assigns positions only. Layer 2 (scores, eligibility) must be
 * identical with the bandit off, shadow or live.
 */

after(() => {
  delete process.env.BANDIT_MODE;
});

const order = (r: RankedCandidate[]) => r.map((c) => c.astrologer.id);
const policy = config.ranking.bandit.policyVersion;

test("Layer 3 never changes a score or the eligible set; off/shadow/holdout keep the Layer-2 order", async () => {
  await freshBandit("off");
  const off = await runRanking(request(viewerIn("treatment")), { now: NOW });
  assert.equal(off.context.bandit, undefined);

  await freshBandit("live");
  const live = await runRanking(request(viewerIn("treatment")), { now: NOW });
  assert.deepEqual([...order(live.ranked)].sort(), [...order(off.ranked)].sort());
  const offScores = new Map(off.ranked.map((c) => [c.astrologer.id, c.score]));
  for (const c of live.ranked) {
    assert.equal(c.score, offScores.get(c.astrologer.id), "score untouched");
    assert.ok(!c.explanation.extension?.terms.some((t) => (t.name as string) === "banditScore"), "nothing added to totalScore");
  }

  await freshBandit("shadow");
  const shadow = await runRanking(request(viewerIn("treatment")), { now: NOW });
  assert.deepEqual(order(shadow.ranked), order(off.ranked));
  assert.ok(shadow.context.bandit!.decisions.size > 0, "shadow still samples");

  await freshBandit("live");
  const control = await runRanking(request(viewerIn("control")), { now: NOW });
  assert.deepEqual(order(control.ranked), order(off.ranked));
  assert.equal(control.context.bandit?.variant, "control");
});

test("below the Thompson slots the Layer-2 order resumes", async () => {
  await freshBandit("live");
  const run = await runRanking(request(viewerIn("treatment")), { now: NOW });
  const tail = run.ranked.slice(config.ranking.bandit.slots);
  for (let i = 1; i < tail.length; i++) assert.ok(tail[i - 1].layer2Rank! < tail[i].layer2Rank!);
  run.ranked.forEach((c, i) => assert.equal(c.rank, i + 1));
});

test("no starvation: low Layer-2 astrologers with no data reach the top 3 for some viewers", async () => {
  await freshBandit("live");
  const viewers = treatmentViewers(200);
  const timesInTop3 = new Map<string, number>();
  let competitors = new Set<string>();
  let layer2Order: string[] = [];
  for (const v of viewers) {
    const run = await runRanking(request(v), { now: NOW });
    layer2Order = [...run.ranked].sort((a, b) => a.layer2Rank! - b.layer2Rank!).map((c) => c.astrologer.id);
    // Moved candidates (either way) are the ones that compete for slots.
    for (const c of run.ranked) if (c.rank !== c.layer2Rank) competitors.add(c.astrologer.id);
    for (const c of run.ranked.slice(0, 3)) timesInTop3.set(c.astrologer.id, (timesInTop3.get(c.astrologer.id) ?? 0) + 1);
  }
  competitors = new Set([...competitors]);
  const lowest = layer2Order.filter((id) => competitors.has(id)).at(-1)!;
  assert.ok((timesInTop3.get(lowest) ?? 0) > 0, `the lowest-ranked competitor (${lowest}, Layer-2 #${layer2Order.indexOf(lowest) + 1}) never reached the top 3`);
  // …but Layer 2 still matters with no data: its #1 is in the top 3 more often than its lowest competitor.
  assert.ok((timesInTop3.get(layer2Order.find((id) => competitors.has(id))!) ?? 0) > (timesInTop3.get(lowest) ?? 0));
});

test("data overrides Layer 2: a proven converter rises, a heavily shown non-converter loses the first Thompson slot", async () => {
  await freshBandit("live");
  const viewers = treatmentViewers(60);
  const baseline = await runRanking(request(viewers[0]), { now: NOW });
  // Slots 1..firstSlot-1 are premium slots the bandit never assigns.
  const firstThompson = config.ranking.bandit.firstSlot - 1;
  const pooled = baseline.ranked.filter((c) => c.slot !== "premium" && (c.rank !== c.layer2Rank || c.layer2Rank! <= config.ranking.bandit.slots));
  const byL2 = [...pooled].sort((a, b) => a.layer2Rank! - b.layer2Rank!);
  const top = byL2[0];
  const bottom = byL2.at(-1)!;

  const store = new InMemoryBanditStore();
  setBanditStore(store);
  resetBanditCache();
  const arm = (a: RankedCandidate, trials: number, successes: number) => ({
    id: astrologerArmId(policy, ANY_CONTEXT, a.astrologer.id),
    policy,
    kind: "astrologer" as const,
    context: ANY_CONTEXT,
    astrologerId: a.astrologer.id,
    providerId: a.astrologer.providerId,
    trials,
    successes,
  });
  await store.incrementArms([arm(bottom, 200, 40), arm(top, 2000, 0)], NOW);

  let bottomFirst = 0;
  let topFirst = 0;
  for (const v of viewers) {
    const run = await runRanking(request(v), { now: NOW + HOUR_MS });
    if (run.ranked[firstThompson].astrologer.id === bottom.astrologer.id) bottomFirst++;
    if (run.ranked[firstThompson].astrologer.id === top.astrologer.id) topFirst++;
  }
  assert.ok(bottomFirst > viewers.length / 2, `proven converter (Layer-2 #${bottom.layer2Rank}) in the first Thompson slot for ${bottomFirst}/${viewers.length}`);
  assert.equal(topFirst, 0, "a non-converting Layer-2 leader loses the first Thompson slot");
});

test("the user's favourite keeps its Layer-2 position (pinPersonal)", async () => {
  await freshBandit("live", { users: ["favoriteOnly"] });
  const run = await runRanking(request("user-favourite"), { now: NOW });
  const fav = run.ranked.find((c) => c.astrologer.id === ASTRO.dev.id);
  assert.ok(fav, "favourite is eligible");
  assert.equal(fav.rank, fav.layer2Rank);
});

test("same viewer, same time bucket → same order (stable on refresh)", async () => {
  await freshBandit("live");
  const v = viewerIn("treatment");
  const a = await runRanking(request(v), { now: NOW });
  const b = await runRanking(request(v), { now: NOW + 1000 });
  assert.deepEqual(order(a.ranked), order(b.ranked));
});

test("a failing bandit store keeps the Layer-2 order", async () => {
  await freshBandit("off");
  const off = await runRanking(request(viewerIn("treatment")), { now: NOW });
  await freshBandit("live");
  const broken = new InMemoryBanditStore();
  broken.getArms = async () => {
    throw new Error("mongo down");
  };
  setBanditStore(broken);
  const run = await runRanking(request(viewerIn("treatment")), { now: NOW });
  assert.equal(run.context.bandit, undefined);
  assert.deepEqual(order(run.ranked), order(off.ranked));
});

test("mode precedence: BANDIT_MODE env > admin flag > config", async () => {
  await freshBandit("live");
  delete process.env.BANDIT_MODE;
  assert.deepEqual(await resolveMode(NOW), { mode: config.ranking.bandit.mode, source: "config" });
  await setModeFlag("shadow", "test", NOW);
  assert.deepEqual(await resolveMode(NOW), { mode: "shadow", source: "admin" });
  process.env.BANDIT_MODE = "off";
  assert.deepEqual(await resolveMode(NOW), { mode: "off", source: "env" });
});
