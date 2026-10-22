import type { NextRequest } from "next/server";
import { getRankingEngine } from "@/lib/ranking";
import { requireAdmin } from "../../../_lib/auth";
import { handle, ok } from "../../../_lib/http";
import { debugBodySchema } from "../../../_lib/schemas";
import { parseJsonBody } from "../../../_lib/validation";

/** POST /api/admin/ranking/debug — per-signal score breakdown for a context. */
export const POST = handle(async (req: NextRequest, { requestId }) => {
  requireAdmin(req);
  const body = await parseJsonBody(req, debugBodySchema);
  const result = await getRankingEngine().debug(body);
  return ok(result.candidates, { requestId, engine: result.engine });
});
