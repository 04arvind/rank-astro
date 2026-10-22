import type { NextRequest } from "next/server";
import { z } from "zod";
import { exportAstrologers } from "@/db/adminStore";
import { requireAdminSession, requireDatabase } from "../../../_lib/adminSession";
import { handle } from "../../../_lib/http";
import { parseQuery } from "../../../_lib/validation";

const COLUMNS = [
  ["id", "id"],
  ["providerId", "provider"],
  ["name", "name"],
  ["perMinute", "price_per_minute"],
  ["rating", "rating"],
  ["reviewCount", "review_count"],
  ["experienceYears", "experience_years"],
  ["languages", "languages"],
  ["categories", "categories"],
  ["specializations", "specializations"],
  ["status", "status"],
  ["verified", "verified"],
  ["tier", "tier"],
  ["missing", "missing_fields"],
  ["unmapped", "unmapped_values"],
] as const;

/** Quotes a CSV cell; a leading =,+,-,@ is prefixed so spreadsheets don't run it as a formula. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** GET /api/admin/astrologers/export?providerId= — live astrologers as CSV. */
export const GET = handle(async (req: NextRequest, { requestId }) => {
  requireAdminSession(req);
  requireDatabase();
  const { providerId } = parseQuery(req, z.object({ providerId: z.string().trim().max(64).optional() }));
  const rows = await exportAstrologers(providerId);
  const body = [COLUMNS.map(([, h]) => h).join(","), ...rows.map((r) => COLUMNS.map(([k]) => csvCell(r[k])).join(","))].join("\r\n");
  const name = `astrologers-${providerId ?? "all"}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(`﻿${body}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
});
