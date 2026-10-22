import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@/config";
import { HOUR_MS, MINUTE_MS } from "@/lib/utils/time";
import type { ExposureRecord } from "@/lib/ranking/bandit";

/*
 * MongoBanditStore and the full reconcile loop against a real MongoDB.
 * Opt-in: BANDIT_TEST_MONGO_URI=mongodb://127.0.0.1:27099 npm test
 * Uses (and drops) its own database, never MONGO_URI's.
 */

const uri = process.env.BANDIT_TEST_MONGO_URI;
const DB = `rank_astro_bandit_test_${process.pid}`;
const policy = config.ranking.bandit.policyVersion;

before(() => {
  if (!uri) return;
  process.env.MONGO_URI = uri;
  process.env.MONGO_DB_NAME = DB;
});

after(async () => {
  if (!uri) return;
  const { getDb, closeDb } = await import("@/db/client");
  await (await getDb()).dropDatabase();
  await closeDb();
  delete process.env.BANDIT_MODE;
});

const exposure = (over: Partial<ExposureRecord> = {}): ExposureRecord => ({
  id: crypto.randomUUID(),
  policy,
  viewerKey: "user-0",
  userId: "user-0",
  astrologerId: "a1",
  providerId: "providerA",
  context: "*",
  variant: "treatment",
  mode: "live",
  surface: "rank",
  position: 1,
  weight: 1,
  firstAt: 1_000,
  lastAt: 1_000,
  sample: 0.02,
  posteriorMean: 0.02,
  convertedBy: null,
  ...over,
});

test("Mongo store: exposures count once under concurrency; outcomes and leases are compare-and-set", { skip: !uri && "set BANDIT_TEST_MONGO_URI" }, async () => {
  const { MongoBanditStore } = await import("@/db/banditStore");
  const s = new MongoBanditStore();

  const e = exposure({ id: "dup-1" });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => s.recordExposures([{ ...e, lastAt: 1_000 + i, position: 8 - i }])));
  assert.equal(results.reduce((n, r) => n + r.length, 0), 1, "only one concurrent upsert inserts");

  await s.incrementArms([{ id: "arm-1", policy, kind: "astrologer", context: "*", astrologerId: "a1", providerId: "providerA", trials: 0.5 }], 1);
  await Promise.all(Array.from({ length: 10 }, () => s.incrementArms([{ id: "arm-1", policy, kind: "astrologer", context: "*", astrologerId: "a1", providerId: "providerA", trials: 1, successes: 1 }], 2)));
  const [arm] = await s.getArms(["arm-1"]);
  assert.equal(arm.trials, 10.5);
  assert.equal(arm.successes, 10);

  const o = { bookingId: "b1", policy, status: "pending" as const, astrologerId: "a1", providerId: "providerA", userId: "user-0", revenue: 100, margin: 35, bookedAt: 1_500, completedAt: 2_000, processedAt: 10_000 };
  const claims = await Promise.all([s.claimOutcome(o, 0), s.claimOutcome(o, 0), s.claimOutcome(o, 0)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await s.claimOutcome({ ...o, processedAt: 20_000 }, 15_000), true, "stale pending is taken over");

  const conv = await Promise.all([
    s.convertExposure({ policy, viewerKeys: ["user-0"], astrologerId: "a1", from: 0, to: 2_000, bookingId: "b1" }),
    s.convertExposure({ policy, viewerKeys: ["user-0"], astrologerId: "a1", from: 0, to: 2_000, bookingId: "b2" }),
  ]);
  assert.equal(conv.filter((x) => x !== null).length, 1, "one exposure credits one booking");

  const fin = await Promise.all([s.finishOutcome("b1", { status: "applied" }), s.finishOutcome("b1", { status: "applied" })]);
  assert.deepEqual(fin.sort(), [false, true]);

  assert.equal(await s.tryLease("L", "p1", 5_000, 1_000), true);
  assert.equal(await s.tryLease("L", "p2", 5_000, 2_000), false);
  assert.equal(await s.tryLease("L", "p2", 9_000, 6_000), true, "expired lease is taken");
  await s.releaseLease("L", "p2");
  assert.equal(await s.tryLease("L", "p3", 9_000, 6_000), true);

  await s.setMeta("flags", { mode: "shadow" });
  assert.deepEqual(await s.getMeta("flags"), { mode: "shadow" });
});

test("Mongo end to end: serve → completed booking → credited once → rebuild matches", { skip: !uri && "set BANDIT_TEST_MONGO_URI" }, async () => {
  process.env.BANDIT_MODE = "live";
  const { MongoBanditStore } = await import("@/db/banditStore");
  const { MongoBookingStore } = await import("@/db/bookingStore");
  const { ensureIndexes } = await import("@/db/collections");
  const { setBookingStore } = await import("@/lib/booking");
  const bandit = await import("@/lib/ranking/bandit");
  const { runRanking } = await import("@/lib/ranking");
  const { seed, ASTRO, NOW } = await import("@/test/fixtures");

  await seed();
  await ensureIndexes();
  const store = new MongoBanditStore();
  bandit.setBanditStore(store);
  bandit.resetBanditCache();
  const bookings = new MongoBookingStore();
  setBookingStore(bookings);

  const at = NOW - 2 * HOUR_MS;
  const ctx = { user: { userId: "user-0", sessionId: "s-0" }, context: {}, filters: { onlineOnly: false }, pagination: { limit: 50, offset: 0 } };
  const run = await runRanking(ctx, { now: at });
  const logged = await bandit.recordServed({
    bandit: run.context.bandit,
    surface: "rank",
    requestId: "req-1",
    user: ctx.user,
    items: run.ranked.map((c) => ({ astrologerId: c.astrologer.id, providerId: c.astrologer.providerId, position: c.rank })),
    now: at,
  });
  assert.ok(logged.newExposures > 0);

  const a = ASTRO.arjun;
  await bookings.create({
    bookingId: "bk-1",
    astrologerId: a.id,
    providerId: a.providerId,
    userId: "user-0",
    mode: "audio",
    startAt: NOW - 60 * MINUTE_MS,
    endAt: NOW - 30 * MINUTE_MS,
    durationMinutes: 30,
    pricePerMinute: a.pricing.perMinute,
    status: "confirmed",
    createdAt: NOW - 90 * MINUTE_MS,
    kind: "scheduled",
    connectedAt: NOW - 60 * MINUTE_MS,
    issue: null,
  });

  const rs = await Promise.all([bandit.reconcileOutcomes({ now: NOW, owner: "x" }), bandit.reconcileOutcomes({ now: NOW, owner: "y" })]);
  const again = await bandit.reconcileOutcomes({ now: NOW + MINUTE_MS, owner: "z" });
  assert.equal(rs[0].applied + rs[1].applied + again.applied, 1);

  const id = `${policy}|*|a:${a.id}`;
  const [before] = await store.getArms([id]);
  assert.equal(before.successes, 1);
  await bandit.rebuildArms(policy, NOW);
  const [rebuilt] = await store.getArms([id]);
  assert.equal(rebuilt.successes, 1);
  assert.ok(Math.abs(rebuilt.trials - before.trials) < 1e-9);

  const report = await bandit.getBanditReport({ now: NOW });
  assert.equal(report.outcomes.applied, 1);
  assert.ok(report.variants.some((v) => v.completions === 1));
});
