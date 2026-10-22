import { InMemoryBookingStore, setBookingStore } from "@/lib/booking";
import { InMemoryBanditStore, resetBanditCache, setBanditStore, variantOf } from "@/lib/ranking/bandit";
import { MINUTE_MS } from "@/lib/utils/time";
import type { RankingContext } from "@/types/ranking";
import type { Booking } from "@/types/booking";
import { ASTRO, NOW, seed } from "@/test/fixtures";

/** Fresh fixtures + empty bandit and booking stores; mode via BANDIT_MODE. */
export async function freshBandit(mode: "off" | "shadow" | "live" = "live", options: Parameters<typeof seed>[0] = {}) {
  process.env.BANDIT_MODE = mode;
  await seed(options);
  const bandit = new InMemoryBanditStore();
  const bookings = new InMemoryBookingStore();
  setBanditStore(bandit);
  setBookingStore(bookings);
  resetBanditCache();
  // Each test starts with a cold reconcile throttle.
  (globalThis as { __banditReconcileAt?: number }).__banditReconcileAt = undefined;
  return { bandit, bookings };
}

export function request(userId: string, over: Partial<RankingContext["context"]> = {}): RankingContext {
  return { user: { userId, sessionId: `s-${userId}` }, context: over, filters: { onlineOnly: false }, pagination: { limit: 50, offset: 0 } };
}

/** First viewer key (deterministic) that lands in the given variant. */
export function viewerIn(variant: "treatment" | "control"): string {
  for (let i = 0; ; i++) if (variantOf(`user-${i}`) === variant) return `user-${i}`;
}

/** `n` distinct treatment viewers, to simulate many users. */
export function treatmentViewers(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (variantOf(`viewer-${i}`) === "treatment") out.push(`viewer-${i}`);
  return out;
}

/** A User-Choice booking (no `minutes`) that connected and ended before NOW. */
export function completedBooking(over: Partial<Booking> = {}): Booking {
  const a = ASTRO.arjun;
  return {
    bookingId: crypto.randomUUID(),
    astrologerId: a.id,
    providerId: a.providerId,
    userId: "user-0",
    mode: "audio",
    startAt: NOW - 60 * MINUTE_MS,
    endAt: NOW - 30 * MINUTE_MS,
    durationMinutes: 30,
    pricePerMinute: a.pricing.perMinute,
    status: "confirmed",
    createdAt: NOW - 90 * MINUTE_MS,
    kind: "scheduled",
    connectedAt: NOW - 60 * MINUTE_MS,
    issue: null,
    ...over,
  };
}

export { ASTRO, NOW };
