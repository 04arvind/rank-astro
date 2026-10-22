import { after, type NextRequest } from "next/server";
import { recordImpressions } from "@/lib/analytics";
import { logError } from "@/lib/errors";
import { getRankingEngine } from "@/lib/ranking";
import { maybeReconcile, recordServed } from "@/lib/ranking/bandit";
import { recordTrainingSample } from "@/lib/ranking/ml";
import type { RankingContext } from "@/types/ranking";
import { handle, ok, type HandlerContext } from "../../_lib/http";
import { rankBodySchema, rankQuerySchema } from "../../_lib/schemas";
import { parseJsonBody, parseQuery } from "../../_lib/validation";

async function respond(ctx: RankingContext, { requestId }: HandlerContext) {
  const result = await getRankingEngine().rank(ctx);

  // Log served impressions without delaying the response.
  after(() =>
    recordImpressions(
      result.items.map((item) => ({
        astrologerId: item.astrologer.id,
        providerId: item.astrologer.providerId,
        position: item.rank,
        requestId,
        engineVersion: result.engine.version,
        category: ctx.context.category,
        userId: ctx.user.userId,
        sessionId: ctx.user.sessionId,
      })),
    ).catch((err) => logError(err, { scope: "analytics", requestId, operation: "recordImpressions" })),
  );
  // Thompson sampling: exposures (trials) for what was served, then credit any newly completed consultations.
  // Learned ranker: the served list's feature rows, labelled later from clicks and bookings.
  after(async () => {
    const items = result.items.map((item) => ({ astrologerId: item.astrologer.id, providerId: item.astrologer.providerId, position: item.rank }));
    await Promise.all([
      recordServed({ bandit: result.bandit, surface: "rank", requestId, user: ctx.user, items }),
      result.trainingRows &&
        recordTrainingSample({ requestId, surface: "rank", user: ctx.user, category: result.category, segment: result.segment, items, rows: result.trainingRows }),
    ]);
    await maybeReconcile();
  });

  return ok(result.items, {
    requestId,
    engine: result.engine,
    pagination: { ...ctx.pagination, total: result.total },
  });
}

/** POST /api/astrologer/rank — full JSON context (preferred). */
export const POST = handle(async (req: NextRequest, hc) =>
  respond(await parseJsonBody(req, rankBodySchema), hc),
);

/** GET /api/astrologer/rank?category=love&languages=hi,en&limit=20 */
export const GET = handle(async (req: NextRequest, hc) =>
  respond(parseQuery(req, rankQuerySchema), hc),
);
