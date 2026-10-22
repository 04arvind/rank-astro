import assert from "node:assert/strict";
import { test } from "node:test";
import { recordClicks } from "@/lib/analytics";
import { createRankingEngine } from "@/lib/ranking";
import { buildTrainingSet, ML_FEATURE_VERSION, recordTrainingSample } from "@/lib/ranking/ml";
import { HOUR_MS, MINUTE_MS } from "@/lib/utils/time";
import { completedBooking } from "../bandit/helpers";
import { freshPipeline, NOW, request } from "./helpers";

/*
 * Training data for the learned ranker: served lists are logged with their
 * feature rows, then labelled from clicks and bookings.
 */

async function serve(userId: string, at: number, requestId: string) {
  const ctx = { ...request(userId), pagination: { limit: 6, offset: 0 } };
  const result = await createRankingEngine().rank(ctx);
  const items = result.items.map((i) => ({ astrologerId: i.astrologer.id, providerId: i.astrologer.providerId, position: i.rank }));
  const ok = await recordTrainingSample({ requestId, surface: "rank", user: ctx.user, items, rows: result.trainingRows!, now: at });
  return { items, ok };
}

test("served lists are logged with feature rows; anonymous viewers and one-item lists are not", async () => {
  const { trainingLog } = await freshPipeline("off");
  const { items, ok } = await serve("user-1", NOW - HOUR_MS, "req-1");
  assert.ok(ok);
  const [s] = trainingLog.samples;
  assert.equal(s.id, "req-1");
  assert.equal(s.featureVersion, ML_FEATURE_VERSION);
  assert.deepEqual(s.items.map((i) => i.astrologerId), items.map((i) => i.astrologerId));

  const rows = new Map([[items[0].astrologerId, s.items[0].features]]);
  assert.equal(await recordTrainingSample({ requestId: "anon", surface: "rank", user: {}, items, rows }), false);
  assert.equal(await recordTrainingSample({ requestId: "one", surface: "rank", user: { userId: "u" }, items, rows }), false);
});

test("labels: completed consultation 3, booking 2, click 1, shown 0 — each booking credits the latest list", async () => {
  const { bookings } = await freshPipeline("off");
  const older = await serve("user-0", NOW - 5 * HOUR_MS, "req-old");
  const latest = await serve("user-0", NOW - 3 * HOUR_MS, "req-new");
  const [first, second, third] = latest.items;

  await recordClicks([{ astrologerId: third.astrologerId, providerId: third.providerId, requestId: "req-new", userId: "user-0", timestamp: NOW - 3 * HOUR_MS + MINUTE_MS }]);
  // Completed User-Choice consultation with the first astrologer, booked after both lists.
  await bookings.create(completedBooking({ astrologerId: first.astrologerId, providerId: first.providerId, createdAt: NOW - 2 * HOUR_MS }));
  // Booked (call still in the future) with the second.
  await bookings.create(
    completedBooking({ astrologerId: second.astrologerId, providerId: second.providerId, createdAt: NOW - 2 * HOUR_MS, connectedAt: undefined, startAt: NOW + HOUR_MS, endAt: NOW + 2 * HOUR_MS }),
  );
  // First-Out (duration card) bookings don't label anything.
  await bookings.create(
    completedBooking({
      astrologerId: third.astrologerId,
      providerId: third.providerId,
      createdAt: NOW - 2 * HOUR_MS,
      minutes: 15,
      startAt: NOW - 110 * MINUTE_MS,
      endAt: NOW - 95 * MINUTE_MS,
      connectedAt: NOW - 110 * MINUTE_MS,
    }),
  );

  const set = await buildTrainingSet({ from: NOW - 24 * HOUR_MS, to: NOW, now: NOW });
  assert.equal(set.queries, 2);
  const label = (qid: string, id: string) => set.rows.find((r) => r.qid === qid && r.astrologerId === id)!.label;
  assert.equal(label("req-new", first.astrologerId), 3);
  assert.equal(label("req-new", second.astrologerId), 2);
  assert.equal(label("req-new", third.astrologerId), 1);
  assert.equal(label("req-old", first.astrologerId), 0, "the booking credits only the latest list");
  assert.ok(older.items.length > 3 && label("req-new", latest.items[3].astrologerId) === 0);
  assert.equal(set.positiveQueries, 1);
});
