import type { NextRequest } from "next/server";
import { getRankingStats } from "@/lib/analytics";
import { requireAdmin } from "../../../_lib/auth";
import { handle, ok } from "../../../_lib/http";
import { statsQuerySchema } from "../../../_lib/schemas";
import { parseQuery } from "../../../_lib/validation";

/** GET /api/admin/ranking/stats?window=24h&providerId=... — provider exposure metrics. */
export const GET = handle(async (req: NextRequest, { requestId }) => {
  requireAdmin(req);
  const query = parseQuery(req, statsQuerySchema);
  const stats = await getRankingStats(query);
  return ok(stats, { requestId });
});
