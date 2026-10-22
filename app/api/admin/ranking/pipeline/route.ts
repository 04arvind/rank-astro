import type { NextRequest } from "next/server";
import { getRankingEngine } from "@/lib/ranking";
import { requireAdmin } from "../../../_lib/auth";
import { handle, ok } from "../../../_lib/http";
import { debugBodySchema } from "../../../_lib/schemas";
import { parseJsonBody } from "../../../_lib/validation";

/**
 * POST /api/admin/ranking/pipeline — the ranked list after each of the six
 * layers (eligibility → business → candidates → ML → exploration → final),
 * with filtered candidates and per-candidate positions. Same body as
 * /api/admin/ranking/debug.
 */
export const POST = handle(async (req: NextRequest, { requestId }) => {
  requireAdmin(req);
  const body = await parseJsonBody(req, debugBodySchema);
  const result = await getRankingEngine().debug(body);
  return ok({ pipeline: result.pipeline ?? null, candidates: result.candidates }, { requestId, engine: result.engine });
});
