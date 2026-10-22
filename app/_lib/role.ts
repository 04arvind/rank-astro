import { cookies } from "next/headers";

/*
 * Which kind of visitor is browsing, picked on the role screen at "/".
 * No authentication yet: it is only a cookie that shapes the navbar and
 * where each role lands.
 */

export const ROLES = ["user", "astrologer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_COOKIE = "role";

/** Where each role lands after picking it. */
export const ROLE_HOME: Record<Role, string> = {
  user: "/user",
  admin: "/admin",
  // Picks their profile, then the astrologer dashboard.
  astrologer: "/astrologer/login",
};

/** URL prefix each role owns; only that role may visit pages under it (see proxy.ts). */
export const ROLE_PREFIX: Record<Role, string> = {
  user: "/user",
  admin: "/admin",
  astrologer: "/astrologer",
};

export const isRole = (v: unknown): v is Role => (ROLES as readonly unknown[]).includes(v);

/** The role that owns a path, or null for shared paths like "/". */
export function roleForPath(pathname: string): Role | null {
  return ROLES.find((r) => pathname === ROLE_PREFIX[r] || pathname.startsWith(`${ROLE_PREFIX[r]}/`)) ?? null;
}

export async function getRole(): Promise<Role | null> {
  const v = (await cookies()).get(ROLE_COOKIE)?.value;
  return isRole(v) ? v : null;
}
