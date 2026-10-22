import type { NextRequest } from "next/server";
import { isDatabaseConfigured } from "@/db";
import { ApiError } from "@/lib/errors";
import { ROLE_COOKIE } from "../../_lib/role";
import { requireAdmin } from "./auth";

/**
 * Guards the dashboard's admin controls. Accepts the `x-admin-key` header
 * (scripts, see requireAdmin), or a same-origin browser request from a
 * visitor who picked the admin role at "/". The role cookie is not real
 * authentication — put the dashboard behind proper auth before going live.
 */
export function requireAdminSession(req: NextRequest): void {
  const sameOrigin = (() => {
    const origin = req.headers.get("origin");
    if (!origin) return req.headers.get("sec-fetch-site") === "same-origin";
    try {
      return new URL(origin).host === req.headers.get("host");
    } catch {
      return false;
    }
  })();
  if (sameOrigin && req.cookies.get(ROLE_COOKIE)?.value === "admin") return;
  if (req.headers.get("x-admin-key") || !sameOrigin || process.env.NODE_ENV === "development") return requireAdmin(req);
  throw new ApiError("FORBIDDEN", "Pick the admin role on the home screen to use admin controls");
}

/** Admin controls write to MongoDB; without it there is nothing to manage. */
export function requireDatabase(): void {
  if (!isDatabaseConfigured()) {
    throw new ApiError("SERVICE_DISABLED", "MongoDB is not configured — set MONGO_URI in .env");
  }
}
