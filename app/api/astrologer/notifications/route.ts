import type { NextRequest } from "next/server";
import { z } from "zod";
import { getNotificationStore } from "@/lib/booking";
import { requireAdmin } from "../../_lib/auth";
import { handle, ok } from "../../_lib/http";
import { parseJsonBody, parseQuery } from "../../_lib/validation";

/*
 * An astrologer's notification inbox (new bookings). There is no astrologer
 * login yet, so this is guarded by the admin key and meant for the provider
 * integration / ops tooling that relays notices to astrologers.
 *   GET   ?astrologerId=…&unreadOnly=true&limit=50
 *   PATCH { astrologerId, notificationIds } — mark read
 */

const id = z.string().trim().min(1).max(128);

const querySchema = z.object({
  astrologerId: id,
  unreadOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const markReadSchema = z.object({
  astrologerId: id,
  notificationIds: z.array(id).min(1).max(200),
});

export const GET = handle(async (req: NextRequest, { requestId }) => {
  requireAdmin(req);
  const q = parseQuery(req, querySchema);
  const items = await getNotificationStore().listForAstrologer(q.astrologerId, { unreadOnly: q.unreadOnly, limit: q.limit });
  return ok(items, { requestId });
});

export const PATCH = handle(async (req: NextRequest, { requestId }) => {
  requireAdmin(req);
  const body = await parseJsonBody(req, markReadSchema);
  const updated = await getNotificationStore().markRead(body.astrologerId, body.notificationIds, Date.now());
  return ok({ updated }, { requestId });
});
