import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHomeFeed } from "@/lib/feed";
import { recordServed } from "@/lib/ranking/bandit";
import { freshBandit, NOW, request, viewerIn } from "./helpers";

test("home feed: bandit samples flow through and every placed astrologer is one exposure", async () => {
  const { bandit } = await freshBandit("live");
  const ctx = request(viewerIn("treatment"));
  const { feed, run } = await buildHomeFeed(ctx, { now: NOW });
  const items = feed.columns.flatMap((col) => col.items.map((i) => ({ astrologerId: i.astrologer.id, providerId: i.astrologer.providerId, position: i.position, placement: col.id })));
  assert.ok(items.length > 0);
  const logged = await recordServed({ bandit: run.context.bandit, surface: "feed", requestId: "r1", user: ctx.user, items, now: NOW });
  assert.equal(logged.newExposures, new Set(items.map((i) => i.astrologerId)).size);
  assert.equal(bandit.recommendations[0].items.length, items.length);
  assert.ok(bandit.recommendations[0].items.every((i) => i.sample !== null));
});
