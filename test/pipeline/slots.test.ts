import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@/config";
import { runRanking } from "@/lib/ranking";
import { setRankerArtifact } from "@/lib/ranking/ml";
import { freshPipeline, NOW, request } from "./helpers";
import { treatmentViewers, viewerIn } from "../bandit/helpers";

/*
 * Slot layout: 1–2 premium (top-ranked qualified premium, else top-ranked),
 * 3–4 Thompson sampling only (rest of the first row), 5+ the normal (pre-bandit) order.
 */

after(() => {
  delete process.env.BANDIT_MODE;
  setRankerArtifact(undefined);
});

const premiumCount = config.ranking.premiumSlots.count;
const { firstSlot, slots: lastSlot } = config.ranking.bandit;

test("slots 1–2 hold the premium slots in every bandit mode", async () => {
  for (const mode of ["off", "shadow", "live"] as const) {
    await freshPipeline(mode);
    const run = await runRanking(request(viewerIn("treatment")), { now: NOW });
    const head = run.ranked.slice(0, premiumCount);
    assert.ok(head.every((c) => c.slot === "premium"), `${mode}: first ${premiumCount} are premium slots`);
    assert.ok(run.ranked.slice(premiumCount).every((c) => c.slot !== "premium"), `${mode}: no premium slot below #${premiumCount}`);
    // Qualified premium astrologers come first, in their pre-bandit order.
    const premium = head.filter((c) => c.features.priceBand === 2);
    assert.ok(premium.length > 0, "fixtures include a qualified premium astrologer");
    assert.equal(head[0].features.priceBand, 2);
  }
});

test("Thompson picks appear only in slots 3–4, and from slot 5 the pre-bandit order resumes", async () => {
  await freshPipeline("live");
  for (const v of treatmentViewers(40)) {
    const run = await runRanking(request(v), { now: NOW });
    run.ranked.forEach((c, i) => {
      if (c.slot === "bandit") assert.ok(i + 1 >= firstSlot && i + 1 <= lastSlot, `bandit pick at #${i + 1}`);
    });
    const tail = run.ranked.slice(lastSlot);
    for (let i = 1; i < tail.length; i++) assert.ok(tail[i - 1].layer2Rank! < tail[i].layer2Rank!, "normal order after the Thompson slots");
    // Premium slots are never re-assigned by the bandit.
    run.ranked.slice(0, firstSlot - 1).forEach((c) => assert.equal(c.rank, c.layer2Rank));
  }
});

test("the admin debug view shows Thompson recommendations only at slots 3–4", async () => {
  const { createRankingEngine } = await import("@/lib/ranking");
  await freshPipeline("live");
  let picks = 0;
  for (const v of treatmentViewers(20)) {
    const result = await createRankingEngine().debug(request(v));
    for (const c of result.candidates.filter((x) => x.thompson)) {
      picks++;
      assert.ok(c.rank! >= firstSlot && c.rank! <= lastSlot, `Thompson info shown at #${c.rank}`);
    }
  }
  assert.ok(picks > 0, "live treatment viewers get Thompson picks");
});

test("with too few qualified premium astrologers, top-ranked astrologers fill the premium slots", async () => {
  const { ALL_ASTROLOGERS } = await import("@/test/fixtures");
  // Keep exactly one premium astrologer.
  const premiumIds = new Set<string>();
  const pool = ALL_ASTROLOGERS.filter((a) => {
    if (a.pricing.perMinute <= config.business.priceBands.standardMax) return true;
    if (premiumIds.size === 0) return premiumIds.add(a.id), true;
    return false;
  });
  await freshPipeline("off", { astrologers: pool });
  const run = await runRanking(request("user-x"), { now: NOW });
  const head = run.ranked.slice(0, premiumCount);
  assert.ok(head.every((c) => c.slot === "premium"));
  assert.equal(head.filter((c) => c.features.priceBand === 2).length, 1);
  assert.ok(head.some((c) => c.adjustments.some((a) => a.stage === "premium" && a.note.includes("not enough qualified premium"))));
});
