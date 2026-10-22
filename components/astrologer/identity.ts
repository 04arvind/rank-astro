/*
 * Anonymous visitor identity for the browser: a guest id kept in
 * localStorage (stable across visits) and a session id in sessionStorage.
 * Client-only — call it from effects or event handlers, never during render.
 */

const GUEST_KEY = "rank_astro:guestId";
const SESSION_KEY = "rank_astro:sessionId";

function storedId(storage: () => Storage, key: string, prefix: string): string {
  try {
    const s = storage();
    const existing = s.getItem(key);
    if (existing) return existing;
    const created = `${prefix}-${crypto.randomUUID()}`;
    s.setItem(key, created);
    return created;
  } catch {
    return `${prefix}-${crypto.randomUUID()}`; // storage blocked: one-off id
  }
}

/** Mirrors the guest id so the admin dashboard (server-rendered) can rank as this browser's visitor. */
export const VISITOR_COOKIE = "rank_astro_visitor";

export const identity = () => {
  const userId = storedId(() => localStorage, GUEST_KEY, "guest");
  try {
    if (!document.cookie.includes(`${VISITOR_COOKIE}=${userId}`)) {
      document.cookie = `${VISITOR_COOKIE}=${encodeURIComponent(userId)}; path=/; max-age=31536000; samesite=lax`;
    }
  } catch {
    // cookies blocked: the dashboard just defaults to anonymous
  }
  return { userId, sessionId: storedId(() => sessionStorage, SESSION_KEY, "session") };
};
