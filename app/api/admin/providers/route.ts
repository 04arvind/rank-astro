import type { NextRequest } from "next/server";
import { z } from "zod";
import { syncAstrologersFromFeeds } from "@/db";
import {
  deleteProvider,
  getAdminProvider,
  getDatabaseOverview,
  listProviderSummaries,
  pauseProvider,
  reapplyHidden,
  resumeProvider,
} from "@/db/adminStore";
import { ValidationError } from "@/lib/errors";
import { runImport } from "../../_lib/adminImport";
import { requireAdminSession, requireDatabase } from "../../_lib/adminSession";
import { handle, ok } from "../../_lib/http";
import { parseJsonBody } from "../../_lib/validation";

/** GET /api/admin/providers — database overview + every provider with live/hidden counts. */
export const GET = handle(async (req: NextRequest, { requestId }) => {
  requireAdminSession(req);
  requireDatabase();
  const [overview, providers] = await Promise.all([getDatabaseOverview(), listProviderSummaries()]);
  return ok({ overview, providers }, { requestId });
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["pause", "resume", "delete", "resync"]), providerId: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal("syncFeeds") }),
]);

/**
 * POST /api/admin/providers {action, providerId}
 *   pause / resume — take all of a provider's astrologers off / back on the list
 *   delete         — remove its astrologers (and the provider, if admin-added)
 *   resync         — re-run the last link import with the saved column mapping
 *   syncFeeds      — re-import the built-in feeds in data/csv (hidden ones stay hidden)
 */
export const POST = handle(async (req: NextRequest, { requestId }) => {
  requireAdminSession(req);
  requireDatabase();
  const body = await parseJsonBody(req, actionSchema);

  switch (body.action) {
    case "pause":
      return ok({ moved: await pauseProvider(body.providerId) }, { requestId });
    case "resume":
      return ok({ moved: await resumeProvider(body.providerId) }, { requestId });
    case "delete":
      return ok(await deleteProvider(body.providerId), { requestId });
    case "resync": {
      const p = await getAdminProvider(body.providerId);
      if (p?.source?.kind !== "link" || !p.source.url) {
        throw new ValidationError("This provider has no saved link to re-sync from — add astrologers again with a link", []);
      }
      const { record } = await runImport({
        providerName: p.name,
        source: p.source,
        mapping: p.mapping,
        mode: p.mode ?? "merge",
        defaultVerified: p.defaultVerified ?? true,
      });
      return ok({ record }, { requestId });
    }
    case "syncFeeds": {
      const r = await syncAstrologersFromFeeds();
      const rehidden = await reapplyHidden();
      return ok(
        { inserted: r.upserted, updated: r.modified, removed: r.removed, rejected: r.rejected.length, byProvider: r.byProvider, failed: r.failed, rehidden },
        { requestId },
      );
    }
  }
});
