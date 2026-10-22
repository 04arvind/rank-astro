import type { NextRequest } from "next/server";
import { z } from "zod";
import { getBanditReport, rebuildArms, reconcileOutcomes, resetBanditCache, resolveMode, setModeFlag } from "@/lib/ranking/bandit";
import { requireAdmin } from "../../_lib/auth";
import { handle, ok } from "../../_lib/http";
import { parseJsonBody, parseQuery } from "../../_lib/validation";

/*
 * Thompson-sampling monitoring and controls (admin key).
 *
 * GET  ?windowDays=30 — mode, treatment vs holdout completion rate and
 *      margin per exposure (with 95% intervals), provider exposure, outcome
 *      ledger counts, top arms, reconciliation lag.
 * POST { action: "reconcile" }            credit completed consultations now
 *      { action: "rebuild" }              recompute counters from the ledgers
 *      { action: "setMode", mode }        runtime flag: "off" | "shadow" | "live",
 *                                         or null to fall back to config (rollback)
 */

const querySchema = z.object({ windowDays: z.coerce.number().int().min(1).max(365).default(30) });
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reconcile") }),
  z.object({ action: z.literal("rebuild") }),
  z.object({ action: z.literal("setMode"), mode: z.enum(["off", "shadow", "live"]).nullable(), by: z.string().trim().max(64).optional() }),
]);

export const GET = handle(async (req: NextRequest, { requestId }) => {
  requireAdmin(req);
  const { windowDays } = parseQuery(req, querySchema);
  return ok(await getBanditReport({ windowDays }), { requestId });
});

export const POST = handle(async (req: NextRequest, { requestId }) => {
  requireAdmin(req);
  const body = await parseJsonBody(req, bodySchema);
  if (body.action === "reconcile") return ok(await reconcileOutcomes(), { requestId });
  if (body.action === "rebuild") return ok({ arms: await rebuildArms() }, { requestId });
  await setModeFlag(body.mode, body.by);
  resetBanditCache();
  return ok({ mode: await resolveMode() }, { requestId });
});
