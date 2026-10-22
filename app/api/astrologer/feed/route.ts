import { after, type NextRequest } from "next/server";
import { config } from "@/config";
import { recordImpressions } from "@/lib/analytics";
import { logError } from "@/lib/errors";
import { buildHomeFeed } from "@/lib/feed";
import { maybeReconcile, recordServed } from "@/lib/ranking/bandit";
import { featureRow, recordTrainingSample } from "@/lib/ranking/ml";
import { handle, ok } from "../../_lib/http";
import { rankQuerySchema } from "../../_lib/schemas";
import { parseQuery } from "../../_lib/validation";

/**
 * GET /api/astrologer/feed — the home page's four columns (Recommended,
 * Popular, Personalized, Premium). Accepts the same filters as
 * GET /api/astrologer/rank, except that category and languages are strict
 * here (only astrologers who list them); pagination is ignored.
 * Every placed astrologer is logged as an impression with its column, which
 * is what feeds provider exposure back into the next request's balancing.
 */
export const GET = handle(async (req: NextRequest, { requestId }) => {
  const ctx = parseQuery(req, rankQuerySchema);
  const { feed, run } = await buildHomeFeed(ctx);
  const personalCtx = run.context.ctx;

  after(() =>
    recordImpressions(
      feed.columns.flatMap((col) =>
        col.items.map((item) => ({
          astrologerId: item.astrologer.id,
          providerId: item.astrologer.providerId,
          position: item.position,
          placement: col.id,
          requestId,
          engineVersion: config.ranking.engine.version,
          category: personalCtx.context.category,
          userId: ctx.user.userId,
          sessionId: ctx.user.sessionId,
        })),
      ),
    ).catch((err) => logError(err, { scope: "analytics", requestId, operation: "recordImpressions" })),
  );
  // Layer 3: exposures (trials) for every placed astrologer, then credit newly completed consultations.
  after(async () => {
    const items = feed.columns.flatMap((col) =>
      col.items.map((item) => ({ astrologerId: item.astrologer.id, providerId: item.astrologer.providerId, position: item.position, placement: col.id })),
    );
    // Feature rows as served, for the learned ranker's training log.
    const byId = new Map(run.ranked.map((c) => [c.astrologer.id, c]));
    const rows = new Map(items.flatMap((it) => (byId.has(it.astrologerId) ? [[it.astrologerId, featureRow(byId.get(it.astrologerId)!)] as const] : [])));
    await Promise.all([
      recordServed({ bandit: run.context.bandit, surface: "feed", requestId, user: ctx.user, items }),
      recordTrainingSample({ requestId, surface: "feed", user: ctx.user, category: personalCtx.context.category, segment: run.user.segment, items, rows }),
    ]);
    await maybeReconcile();
  });

  return ok(feed, { requestId, engine: { name: run.scorer, version: config.ranking.engine.version } });
});
