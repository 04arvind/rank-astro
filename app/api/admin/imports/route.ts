import type { NextRequest } from "next/server";
import { z } from "zod";
import { listImports } from "@/db/adminStore";
import { requireAdminSession, requireDatabase } from "../../_lib/adminSession";
import { handle, ok } from "../../_lib/http";
import { parseQuery } from "../../_lib/validation";

/** GET /api/admin/imports?providerId&limit — import history, newest first, with rejected rows. */
export const GET = handle(async (req: NextRequest, { requestId }) => {
  requireAdminSession(req);
  requireDatabase();
  const q = parseQuery(
    req,
    z.object({ providerId: z.string().trim().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }),
  );
  return ok(await listImports(q), { requestId });
});
