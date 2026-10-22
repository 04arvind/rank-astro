import type { NextRequest } from "next/server";
import { z } from "zod";
import { deleteAstrologers, hideAstrologers, listAdminAstrologers, unhideAstrologers, updateAstrologer } from "@/db/adminStore";
import { requireAdminSession, requireDatabase } from "../../_lib/adminSession";
import { handle, ok } from "../../_lib/http";
import { parseJsonBody, parseQuery } from "../../_lib/validation";

const status = z.enum(["online", "busy", "offline", "unknown"]);

const listQuery = z.object({
  providerId: z.string().trim().max(64).optional(),
  q: z.string().trim().max(100).optional(),
  view: z.enum(["live", "hidden"]).default("live"),
  status: status.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
});

/** GET /api/admin/astrologers?providerId&q&view=live|hidden&status&page — paged astrologer list. */
export const GET = handle(async (req: NextRequest, { requestId }) => {
  requireAdminSession(req);
  requireDatabase();
  const query = parseQuery(req, listQuery);
  return ok(await listAdminAstrologers(query), { requestId, page: query.page, pageSize: query.pageSize });
});

const editSchema = z.object({
  id: z.string().trim().min(1).max(200),
  changes: z
    .object({
      name: z.string().trim().min(2).max(120),
      perMinute: z.number().positive().max(100_000),
      status,
      verified: z.boolean(),
      tier: z.string().trim().max(20).nullable(),
      experienceYears: z.number().min(0).max(80).nullable(),
      rating: z.number().min(0).max(5).nullable(),
    })
    .partial(),
});

/** PATCH /api/admin/astrologers {id, changes} — edit price, status, verification… */
export const PATCH = handle(async (req: NextRequest, { requestId }) => {
  requireAdminSession(req);
  requireDatabase();
  const { id, changes } = await parseJsonBody(req, editSchema);
  return ok(await updateAstrologer(id, { ...changes, tier: changes.tier === "" ? null : changes.tier }), { requestId });
});

const bulkSchema = z.object({
  action: z.enum(["hide", "unhide", "delete"]),
  ids: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
});

/** POST /api/admin/astrologers {action: hide|unhide|delete, ids} — bulk actions. */
export const POST = handle(async (req: NextRequest, { requestId }) => {
  requireAdminSession(req);
  requireDatabase();
  const { action, ids } = await parseJsonBody(req, bulkSchema);
  const affected = action === "hide" ? await hideAstrologers(ids) : action === "unhide" ? await unhideAstrologers(ids) : await deleteAstrologers(ids);
  return ok({ affected }, { requestId });
});
