import { NextResponse, type NextRequest } from "next/server";
import { isRole, ROLE_COOKIE, ROLE_HOME, roleForPath } from "./app/_lib/role";

/*
 * Role-based page access. Each role owns a URL prefix (/user, /astrologer,
 * /admin); visiting another role's pages sends you to your own landing page,
 * and visiting any of them without a role sends you to the picker at "/".
 * The role cookie is not authentication — replace this check once auth lands.
 */
export function proxy(req: NextRequest) {
  const owner = roleForPath(req.nextUrl.pathname);
  if (!owner) return NextResponse.next();

  const role = req.cookies.get(ROLE_COOKIE)?.value;
  if (role === owner) return NextResponse.next();

  const target = isRole(role) ? ROLE_HOME[role] : "/";
  return NextResponse.redirect(new URL(target, req.url));
}

export const config = {
  matcher: ["/user/:path*", "/astrologer/:path*", "/admin/:path*"],
};
