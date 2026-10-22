import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/errors";

/**
 * Guards admin endpoints with the `x-admin-key` header matched against
 * ADMIN_API_KEY. When the env var is unset, access is only allowed in dev.
 */
export function requireAdmin(req: NextRequest): void {
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    if (process.env.NODE_ENV === "development") return;
    throw new ApiError("SERVICE_DISABLED", "Admin API is not enabled", { details: { reason: "ADMIN_API_KEY unset" } });
  }

  const provided = req.headers.get("x-admin-key") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiError("UNAUTHORIZED", "Invalid or missing admin key");
  }
}
