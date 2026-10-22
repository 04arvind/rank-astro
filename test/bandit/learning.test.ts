import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { config } from "@/config";
import { runRanking } from "@/lib/ranking";
import { positionWeight, rebuildArms, reconcileOutcomes, recordServed, type InMemoryBanditStore } from "@/lib/ranking/bandit";
import { astrologerArmId, providerArmId } from "@/lib/ranking/bandit/posterior";
import { ANY_CONTEXT } from "@/lib/ranking/bandit/types";
import type { InMemoryBookingStore } from "@/lib/booking";
import { HOUR_MS, MINUTE_MS } from "@/lib/utils/time";
import { ASTRO, completedBooking, freshBandit, NOW, request } from "./helpers";

const policy = config.ranking.bandit.policyVersion;
const overall = (id: string) => astrologerArmId(policy, ANY_CONTEXT, id);
let bandit: InMemoryBanditStore;
let bookings: InMemoryBookingStore;

beforeEach(async () => {
  ({ bandit, bookings } = await freshBandit("live"));
});

/** Serves a real ranked list to `userId` at `at` and logs it. */
async function serve(userId: string, at = NOW - 2 * HOUR_MS, context: { category?: string } = {}) {
  const ctx = request(userId, context);
  const run = await runRanking(ctx, { now: at });
  const items = run.ranked.map((c) => ({ astrologerId: c.astrologer.id, providerId: c.astrologer.providerId, position: c.rank }));
  const logged = await recordServed({ bandit: run.context.bandit, surface: "rank", requestId: crypto.randomUUID(), user: ctx.user, items, now: at });
  return { run, items, logged };
}

const arm = (id: string) => bandit.arms.get(id);

test("serving a list adds position-weighted trials, once per viewer per dedup window", async () => {
  const { items, logged } = await serve("user-0");
  assert.equal(logged.newExposures, items.length);
  const first = items[0];
  assert.equal(arm(overall(first.astrologerId))!.trials, positionWeight(first.position));
  assert.equal(bandit.recommendations.length, 1);

  const again = await serve("user-0", NOW - 2 * HOUR_MS + MINUTE_MS);
  assert.equal(again.logged.newExposures, 0, "a refresh is not a new trial");
  assert.equal(arm(overall(first.astrologerId))!.trials, positionWeight(first.position));
  assert.equal(bandit.recommendations.length, 2, "every served list is still recorded");
});

test("impressions alone never count as completed consultations", async () => {
  await serve("user-0");
  await serve("user-1");
  const r = await reconcileOutcomes({ now: NOW });
  assert.equal(r.applied, 0);
  for (const a of bandit.arms.values()) assert.equal(a.successes, 0);
});

test("a completed User-Choice booking credits its exposure exactly once, even when reconciled repeatedly or concurrently", async () => {
  await serve("user-0");
  const b = completedBooking({ astrologerId: ASTRO.arjun.id, userId: "user-0" });
  await bookings.create(b);

  const [r1, r2] = await Promise.all([reconcileOutcomes({ now: NOW, owner: "p1" }), reconcileOutcomes({ now: NOW, owner: "p2" })]);
  const r3 = await reconcileOutcomes({ now: NOW + 10 * MINUTE_MS, owner: "p3" });
  assert.equal(r1.applied + r2.applied + r3.applied, 1);
  assert.equal(arm(overall(ASTRO.arjun.id))!.successes, 1);
  assert.equal(arm(providerArmId(policy, ASTRO.arjun.providerId))!.successes, 1);
  const o = bandit.outcomes.get(b.bookingId)!;
  assert.equal(o.status, "applied");
  assert.equal(o.revenue, b.pricePerMinute * b.durationMinutes);
  assert.ok(o.margin > 0 && o.margin < o.revenue);
});

test("First-Out bookings, unconnected or unfinished calls and cancellations are never credited", async () => {
  await serve("user-0");
  await bookings.create(completedBooking({ minutes: 30 })); // First-Out duration card
  await bookings.create(completedBooking({ astrologerId: ASTRO.asha.id, connectedAt: null, startAt: NOW - 3 * HOUR_MS, endAt: NOW - 150 * MINUTE_MS })); // never connected
  await bookings.create(completedBooking({ astrologerId: ASTRO.ramesh.id, startAt: NOW - 10 * MINUTE_MS, endAt: NOW + 20 * MINUTE_MS, connectedAt: NOW - 10 * MINUTE_MS })); // still live
  const r = await reconcileOutcomes({ now: NOW });
  assert.equal(r.completed, 0);
  assert.equal(r.applied, 0);
  assert.equal(bandit.outcomes.size, 0);
});

test("bookings without a prior exposure in the window are unattributed", async () => {
  await serve("user-1");
  // user-0 never saw the list; user-1 saw it only after booking.
  await bookings.create(completedBooking({ userId: "user-0" }));
  await serve("user-2", NOW - 30 * MINUTE_MS);
  await bookings.create(completedBooking({ userId: "user-2", startAt: NOW - 3 * HOUR_MS, endAt: NOW - 150 * MINUTE_MS, connectedAt: NOW - 3 * HOUR_MS, createdAt: NOW - 4 * HOUR_MS }));
  const r = await reconcileOutcomes({ now: NOW });
  assert.equal(r.applied, 0);
  assert.equal(r.unattributed, 2);
  for (const a of bandit.arms.values()) assert.equal(a.successes, 0);
});

test("an abandoned pending claim is taken over and still credited once", async () => {
  await serve("user-0");
  const b = completedBooking();
  await bookings.create(b);
  // A worker claimed it and died before finishing.
  await bandit.claimOutcome(
    { bookingId: b.bookingId, policy, status: "pending", astrologerId: b.astrologerId, providerId: b.providerId, userId: b.userId, revenue: 0, margin: 0, bookedAt: b.createdAt, completedAt: b.endAt, processedAt: NOW - HOUR_MS },
    0,
  );
  const r = await reconcileOutcomes({ now: NOW });
  assert.equal(r.applied, 1);
  assert.equal(arm(overall(b.astrologerId))!.successes, 1);
});

test("rebuildArms recomputes the same counters from the ledgers", async () => {
  await serve("user-0");
  await serve("user-1", NOW - 3 * HOUR_MS, { category: "love" });
  await bookings.create(completedBooking({ userId: "user-0" }));
  await reconcileOutcomes({ now: NOW });
  const before = new Map([...bandit.arms].map(([id, a]) => [id, { t: a.trials, s: a.successes, m: a.margin }]));
  await rebuildArms(policy, NOW);
  assert.equal(bandit.arms.size, before.size);
  for (const [id, a] of bandit.arms) {
    const b = before.get(id)!;
    assert.ok(Math.abs(a.trials - b.t) < 1e-9 && a.successes === b.s && Math.abs(a.margin - b.m) < 1e-9, id);
  }
});

test("off mode logs nothing", async () => {
  ({ bandit, bookings } = await freshBandit("off"));
  const { logged } = await serve("user-0");
  assert.equal(logged.exposures, 0);
  assert.equal(bandit.arms.size, 0);
});
