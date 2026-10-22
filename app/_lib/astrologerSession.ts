import { cookies } from "next/headers";
import { getAstrologerRepository } from "@/lib/astrologer";
import type { AstrologerProfile } from "@/types/astrologer";

/*
 * Which astrologer is using the portal. No authentication yet: the login
 * screen just picks a profile and remembers it in a cookie.
 */

export const ASTROLOGER_COOKIE = "astrologerId";

/** The signed-in astrologer, or null when none is picked or the profile is gone. */
export async function getSignedInAstrologer(): Promise<AstrologerProfile | null> {
  const id = (await cookies()).get(ASTROLOGER_COOKIE)?.value;
  if (!id) return null;
  const [a] = await getAstrologerRepository().getByIds([id]);
  return a ?? null;
}
