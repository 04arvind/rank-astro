import { config } from "@/config";
import { getAstrologerRepository } from "@/lib/astrologer";
import { recordCall } from "@/lib/analytics";
import { getBookingStore, getNotificationStore } from "@/lib/booking";
import { formatSlot, localDayStart } from "@/lib/booking/time";
import type { DurationMinutes } from "@/lib/consultation/offers";
import { AppError, logError, NotFoundError, SlotUnavailableError } from "@/lib/errors";
import { fetchAvailability } from "@/lib/providers";
import { allocateRoundRobin, filterByPreferences, getFirstOutPool } from "@/lib/ranking/first-out";
import { getUserProfile } from "@/lib/user";
import { DAY_MS, MINUTE_MS } from "@/lib/utils/time";
import type { AstrologerProfile } from "@/types/astrologer";
import type { Booking } from "@/types/booking";
import { dayStartOf, todayKey, weekStart } from "./calendar";
import { getRequestStore, requestFor, requestId, type ConsultationRequest } from "./requests";
import { defaultSettings, getPortalStore } from "./store";
import type { CalendarEvent, Consultation, ConsultationStatus, EarningsSummary, PortalNotification, PortalSettings } from "./types";

/*
 * The astrologer portal: an astrologer's own view of their consultations,
 * plus what they manage themselves — availability, accepting or rejecting
 * requests, notification read state. Requests (./requests) carry the
 * user's details and the astrologer's decision; "call now" simulates a
 * completed call through the platform, and a rejected First-Out
 * booking moves on through the First-Out rotation.
 */

export * from "./types";
export * from "./requests";
export { getPortalStore, setPortalStore, defaultSettings } from "./store";

const FOREVER = Number.MAX_SAFE_INTEGER;
/** A booking created this soon after another of the user's was cancelled is the same booking rescheduled. */
const RESCHEDULE_GAP_MS = 10_000;

export async function getAstrologer(astrologerId: string): Promise<AstrologerProfile> {
  const [a] = await getAstrologerRepository().getByIds([astrologerId]);
  if (!a) throw new NotFoundError("astrologer", astrologerId);
  return a;
}

/* ───────────────────────────── settings ───────────────────────────── */

export async function getPortalSettings(astrologerId: string): Promise<PortalSettings> {
  return (await getPortalStore().get(astrologerId)) ?? defaultSettings(astrologerId);
}

const g = globalThis as unknown as { __portalWrites?: Promise<unknown> };

/** Read-modify-write of one astrologer's settings, one at a time in this process. */
export function updatePortalSettings(astrologerId: string, change: (s: PortalSettings) => PortalSettings): Promise<PortalSettings> {
  const run = (g.__portalWrites ?? Promise.resolve()).then(async () => {
    const next = { ...change(await getPortalSettings(astrologerId)), astrologerId, updatedAt: Date.now() };
    await getPortalStore().save(next);
    return next;
  });
  g.__portalWrites = run.catch(() => {});
  return run;
}

/* ───────────────────────────── consultations ───────────────────────────── */

/** When the call actually ends: talk-now calls run their length from connection. */
const callEnd = (b: Booking) => (b.kind === "instant" && b.connectedAt ? b.connectedAt + b.durationMinutes * MINUTE_MS : b.endAt);

/** Bookings made before requests existed count as accepted once approved in the portal settings. */
const isAccepted = (r: ConsultationRequest | undefined, approved: ReadonlySet<string>, bookingId: string) => r?.status === "accepted" || approved.has(bookingId);

function statusOf(b: Booking, accepted: boolean, now: number): ConsultationStatus {
  if (b.status === "cancelled") return "cancelled";
  if (b.status === "expired") return "no_show";
  if (b.connectedAt) return callEnd(b) <= now ? "completed" : "live";
  if (b.kind === "instant") return (b.pickupBy ?? b.endAt) <= now ? "no_show" : accepted ? "confirmed" : "pending";
  if (b.endAt <= now) return "no_show";
  if (!accepted) return "pending";
  return b.startAt <= now ? "due" : "confirmed";
}

function userOf(userId: string, r: ConsultationRequest | undefined, names: Map<string, string | null>): Consultation["user"] {
  return {
    id: userId,
    name: r?.customer?.name ?? names.get(userId) ?? null,
    city: r?.customer?.city ?? null,
    mobile: r?.customer?.mobile ?? null,
  };
}

function toConsultation(b: Booking, r: ConsultationRequest | undefined, a: AstrologerProfile, names: Map<string, string | null>, accepted: boolean, now: number): Consultation {
  const status = statusOf(b, accepted, now);
  const kind = b.kind ?? "scheduled";
  const payoutRate = a.pricing.payoutPerMinute;
  const callable =
    kind === "instant"
      ? status === "pending" || status === "confirmed"
      : (status === "pending" || status === "confirmed" || status === "due") && now < b.endAt;
  return {
    bookingId: b.bookingId,
    kind,
    status,
    source: r?.source ?? (b.minutes ? "first_out" : "user_choice"),
    user: userOf(b.userId, r, names),
    topic: r?.topic ?? null,
    language: r?.language ?? null,
    note: r?.note ?? null,
    requestedAt: r?.createdAt ?? b.createdAt,
    startAt: b.startAt,
    endAt: callEnd(b),
    pickupBy: b.pickupBy ?? null,
    durationMinutes: b.durationMinutes,
    pricePerMinute: b.pricePerMinute,
    amount: r?.payment?.amount ?? Math.round(b.pricePerMinute * b.durationMinutes),
    paid: r?.payment ? { paymentId: r.payment.paymentId, amount: r.payment.amount } : null,
    payout: payoutRate === null ? null : Math.round(payoutRate * b.durationMinutes),
    connectedAt: b.connectedAt ?? null,
    cancelledAt: b.cancelledAt ?? null,
    canAccept: status === "pending",
    canReject: status === "pending",
    canCall: callable,
  };
}

/** A request whose booking is no longer this astrologer's (rejected, or moved away), shown from its snapshot. */
function fromRequest(r: ConsultationRequest, names: Map<string, string | null>): Consultation {
  return {
    bookingId: r.bookingId,
    kind: r.kind,
    status: r.status === "rejected" ? "rejected" : "cancelled",
    source: r.source,
    user: userOf(r.userId, r, names),
    topic: r.topic,
    language: r.language,
    note: r.note ?? (r.status === "rejected" ? null : "Moved to another astrologer"),
    requestedAt: r.createdAt,
    startAt: r.startAt,
    endAt: r.endAt,
    pickupBy: r.pickupBy,
    durationMinutes: r.durationMinutes,
    pricePerMinute: r.pricePerMinute,
    amount: r.payment?.amount ?? Math.round(r.pricePerMinute * r.durationMinutes),
    paid: r.payment ? { paymentId: r.payment.paymentId, amount: r.payment.amount } : null,
    payout: null,
    connectedAt: null,
    cancelledAt: r.decidedAt,
    canAccept: false,
    canReject: false,
    canCall: false,
  };
}

async function displayNames(userIds: Iterable<string>): Promise<Map<string, string | null>> {
  const ids = [...new Set(userIds)];
  const profiles = await Promise.all(
    ids.map((id) =>
      getUserProfile(id).catch((err) => {
        logError(err, { scope: "astrologer-portal", operation: "userProfile" });
        return undefined;
      }),
    ),
  );
  return new Map(ids.map((id, i) => [id, profiles[i]?.displayName?.trim() || null]));
}

/** The astrologer's requests; an unreachable store degrades to none rather than failing the dashboard. */
async function requestsOf(astrologerId: string): Promise<ConsultationRequest[]> {
  try {
    return await getRequestStore().forAstrologer(astrologerId);
  } catch (err) {
    logError(err, { scope: "astrologer-portal", operation: "requests" });
    return [];
  }
}

/** Every consultation booked with or requested of the astrologer, newest start first. */
export async function listConsultations(astrologerId: string, now = Date.now()): Promise<Consultation[]> {
  const [astrologer, settings, bookings, requests] = await Promise.all([
    getAstrologer(astrologerId),
    getPortalSettings(astrologerId),
    getBookingStore().list({ astrologerId, from: 0, to: FOREVER, statuses: ["confirmed", "cancelled", "expired"] }),
    requestsOf(astrologerId),
  ]);
  const names = await displayNames([...bookings.map((b) => b.userId), ...requests.map((r) => r.userId)]);
  const approved = new Set(settings.approvedBookingIds);
  const byBooking = new Map(requests.map((r) => [r.bookingId, r]));
  const mine = new Set(bookings.map((b) => b.bookingId));

  const current = bookings
    .filter((b) => byBooking.get(b.bookingId)?.status !== "rejected")
    .map((b) => {
      const r = byBooking.get(b.bookingId);
      return toConsultation(b, r, astrologer, names, isAccepted(r, approved, b.bookingId), now);
    });
  const elsewhere = requests.filter((r) => r.status === "rejected" || !mine.has(r.bookingId)).map((r) => fromRequest(r, names));
  return [...current, ...elsewhere].sort((x, y) => y.startAt - x.startAt);
}

/**
 * How many requests each astrologer has waiting for a decision: live
 * bookings not yet accepted, rejected or connected. One booking query and
 * one request query for everyone, for the login screen's badges.
 */
export async function pendingRequestCounts(now = Date.now()): Promise<Map<string, number>> {
  const open = (await getBookingStore().list({ from: now, to: FOREVER })).filter(
    (b) => !b.connectedAt && (b.kind !== "instant" || (b.pickupBy ?? b.endAt) > now),
  );
  let decided = new Set<string>();
  try {
    const requests = await getRequestStore().forBookings(open.map((b) => b.bookingId));
    decided = new Set(requests.filter((r) => r.status !== "pending").map((r) => r.id));
  } catch (err) {
    logError(err, { scope: "astrologer-portal", operation: "pendingCounts" });
  }
  const counts = new Map<string, number>();
  for (const b of open) {
    if (!decided.has(requestId(b.bookingId, b.astrologerId))) counts.set(b.astrologerId, (counts.get(b.astrologerId) ?? 0) + 1);
  }
  return counts;
}

/** Accepted and not over: what Upcoming calls shows. */
export const isUpcoming = (c: Consultation) => c.status === "confirmed" || c.status === "due" || c.status === "live";
export const isHistory = (c: Consultation) => c.status === "completed" || c.status === "cancelled" || c.status === "rejected" || c.status === "no_show";

/** Accepted consultations, for the calendar. */
export function toCalendarEvents(consultations: readonly Consultation[]): CalendarEvent[] {
  return consultations
    .filter((c) => isUpcoming(c) || c.status === "completed")
    .map((c) => ({ bookingId: c.bookingId, startAt: c.startAt, endAt: c.endAt, status: c.status, userName: userLabel(c.user) }));
}

/** The user's name, or a short guest reference when they haven't given one. */
export const userLabel = (u: Consultation["user"]) => u.name ?? `Guest ${u.id.replace(/^guest-/, "").slice(0, 6).toUpperCase()}`;

/* ───────────────────────────── earnings ───────────────────────────── */

export function summarizeEarnings(consultations: readonly Consultation[], now = Date.now()): EarningsSummary {
  const { utcOffsetMinutes: off } = config.booking;
  const items = consultations.filter((c) => c.status === "completed").sort((x, y) => y.startAt - x.startAt);
  const today = todayKey(now, off);
  const since = (from: number) => items.filter((c) => c.startAt >= from).reduce((s, c) => s + c.amount, 0);
  const total = items.reduce((s, c) => s + c.amount, 0);
  const payouts = items.map((c) => c.payout);
  return {
    total,
    payout: payouts.length && payouts.every((p) => p !== null) ? payouts.reduce((s: number, p) => s + (p ?? 0), 0) : null,
    completedCalls: items.length,
    averagePerCall: items.length ? Math.round(total / items.length) : 0,
    today: since(localDayStart(now, off)),
    thisWeek: since(dayStartOf(weekStart(today), off)),
    thisMonth: since(dayStartOf(`${today.slice(0, 7)}-01`, off)),
    items,
  };
}

/** Today's accepted consultations, earliest first. */
export function todaysCalls(consultations: readonly Consultation[], now = Date.now()): Consultation[] {
  const from = localDayStart(now, config.booking.utcOffsetMinutes);
  const to = from + DAY_MS;
  return consultations
    .filter((c) => (isUpcoming(c) || c.status === "completed" || c.status === "no_show") && c.startAt >= from && c.startAt < to)
    .sort((x, y) => x.startAt - y.startAt);
}

/* ───────────────────────────── notifications ───────────────────────────── */

/**
 * New bookings come from the booking module's inbox; cancellations and
 * schedule changes are read off the bookings themselves (a reschedule
 * cancels the old booking and books a new one straight after). Bookings
 * the astrologer rejected themselves aren't reported back to them.
 */
export async function listNotifications(astrologerId: string, now = Date.now()): Promise<PortalNotification[]> {
  const { utcOffsetMinutes, timeZoneLabel } = config.booking;
  const store = getBookingStore();
  const [settings, inbox, cancelled, requests] = await Promise.all([
    getPortalSettings(astrologerId),
    getNotificationStore().listForAstrologer(astrologerId, { limit: 100 }),
    store.list({ astrologerId, from: 0, to: FOREVER, statuses: ["cancelled"] }),
    requestsOf(astrologerId),
  ]);
  const seen = settings.notificationsSeenAt;
  const rejected = new Set(requests.filter((r) => r.status === "rejected").map((r) => r.bookingId));

  const out: PortalNotification[] = inbox.map((n) => ({
    id: n.notificationId,
    kind: "new_booking",
    title: n.title,
    message: n.message,
    bookingId: n.bookingId,
    createdAt: n.createdAt,
    read: n.readAt !== null || n.createdAt <= seen,
  }));

  for (const b of cancelled.filter((x) => !rejected.has(x.bookingId))) {
    const at = b.cancelledAt ?? b.createdAt;
    const was = formatSlot(b.startAt, utcOffsetMinutes, timeZoneLabel);
    const theirs = await store.list({ userId: b.userId, from: 0, to: FOREVER, statuses: ["confirmed", "cancelled", "expired"] });
    const moved = theirs.find((x) => x.bookingId !== b.bookingId && x.createdAt >= at && x.createdAt - at <= RESCHEDULE_GAP_MS);
    out.push(
      moved
        ? {
            id: `change:${b.bookingId}`,
            kind: "schedule_change",
            title: "Consultation rescheduled",
            message:
              moved.astrologerId === astrologerId
                ? `The call on ${was} moved to ${formatSlot(moved.startAt, utcOffsetMinutes, timeZoneLabel)}.`
                : `The call on ${was} was moved and is no longer with you.`,
            bookingId: b.bookingId,
            createdAt: at,
            read: at <= seen,
          }
        : {
            id: `cancel:${b.bookingId}`,
            kind: "cancellation",
            title: "Consultation cancelled",
            message: `The user cancelled the ${b.durationMinutes}-min call on ${was}.`,
            bookingId: b.bookingId,
            createdAt: at,
            read: at <= seen,
          },
    );
  }
  return out.filter((n) => n.createdAt <= now + MINUTE_MS).sort((x, y) => y.createdAt - x.createdAt);
}

export async function markAllNotificationsRead(astrologerId: string, now = Date.now()): Promise<void> {
  const unread = (await getNotificationStore().listForAstrologer(astrologerId, { unreadOnly: true, limit: 200 })).map((n) => n.notificationId);
  if (unread.length) await getNotificationStore().markRead(astrologerId, unread, now);
  await updatePortalSettings(astrologerId, (s) => ({ ...s, notificationsSeenAt: now }));
}

/* ───────────────────────────── accept / reject / call ───────────────────────────── */

async function ownConsultation(astrologerId: string, bookingId: string, now: number): Promise<Consultation> {
  const c = (await listConsultations(astrologerId, now)).find((x) => x.bookingId === bookingId && x.status !== "rejected");
  if (!c) throw new NotFoundError("booking", bookingId);
  return c;
}

/** The booking, still confirmed and still this astrologer's. */
async function ownBooking(astrologerId: string, bookingId: string): Promise<Booking> {
  const b = await getBookingStore().get(bookingId);
  if (!b || b.astrologerId !== astrologerId || b.status !== "confirmed") throw new NotFoundError("booking", bookingId);
  return b;
}

const notChangeable = (bookingId: string, why: string) => new AppError("BOOKING_NOT_CHANGEABLE", `Booking ${bookingId} can't be changed: ${why}`);

/** Records the decision on this astrologer's request; a booking made before requests existed gets one now. */
async function decide(astrologerId: string, b: Booking, status: "accepted" | "rejected", now: number, note?: string): Promise<void> {
  const store = getRequestStore();
  const r =
    (await store.get(requestId(b.bookingId, astrologerId))) ??
    requestFor(b, { customer: null, topic: null, language: null }, { source: b.minutes ? "first_out" : "user_choice", now: b.createdAt });
  await store.put({ ...r, status, decidedAt: now, ...(note ? { note } : {}) });
}

export async function acceptRequest(astrologerId: string, bookingId: string, now = Date.now()): Promise<void> {
  const c = await ownConsultation(astrologerId, bookingId, now);
  if (!c.canAccept) throw notChangeable(bookingId, c.status);
  await decide(astrologerId, await ownBooking(astrologerId, bookingId), "accepted", now);
}

/** Thrown inside the rotation when the booking changed under us, so it stops instead of trying the next astrologer. */
class BookingChanged extends Error {}

/**
 * Hands a rejected First-Out booking to the next free astrologer in the
 * First-Out rotation, skipping everyone who already rejected it, and sends
 * them a pending request. Returns them, or null when nobody can take it.
 */
async function reassign(b: Booking, now: number): Promise<AstrologerProfile | null> {
  const requests = getRequestStore();
  const declined = new Set((await requests.forBooking(b.bookingId)).filter((r) => r.status === "rejected").map((r) => r.astrologerId));
  declined.add(b.astrologerId);
  // Same topic and language as the user picked (from the booking, or its first request for older bookings).
  const first = b.preferences ? undefined : await requests.get(requestId(b.bookingId, b.astrologerId));
  const preferences = b.preferences ?? (first ? { topic: first.topic, language: first.language } : undefined);
  let pool = filterByPreferences(await getFirstOutPool(b.minutes as DurationMinutes, now), preferences).filter((a) => !declined.has(a.id));
  if (b.kind === "instant") {
    const live = await fetchAvailability(pool, now);
    pool = pool.filter((a) => (live.get(a.id)?.status ?? a.availability.status) === "online");
  }

  const placed = await allocateRoundRobin(
    pool,
    async (a) => {
      try {
        const moved = await getBookingStore().update(
          b.bookingId,
          { status: "confirmed", astrologerId: b.astrologerId },
          { astrologerId: a.id, providerId: a.providerId, pricePerMinute: a.pricing.perMinute },
        );
        if (!moved) throw new BookingChanged();
        return moved;
      } catch (err) {
        if (err instanceof SlotUnavailableError && err.reason === "astrologer_busy") return null;
        throw err;
      }
    },
    now,
  );
  if (!placed) return null;

  const from = await requests.get(requestId(b.bookingId, b.astrologerId));
  const details = { customer: from?.customer ?? null, topic: from?.topic ?? null, language: from?.language ?? null };
  await requests.put({ ...requestFor(placed.result, details, { source: "first_out", now }), ...(from?.payment ? { payment: from.payment } : {}) });

  const { utcOffsetMinutes, timeZoneLabel, instantPickupMinutes } = config.booking;
  try {
    await getNotificationStore().append({
      notificationId: crypto.randomUUID(),
      astrologerId: placed.astrologer.id,
      providerId: placed.astrologer.providerId,
      type: "booking.scheduled",
      bookingId: b.bookingId,
      scheduledStartAt: placed.result.startAt,
      scheduledEndAt: placed.result.endAt,
      title: "New consultation request",
      message:
        b.kind === "instant"
          ? `Talk-now request (${b.durationMinutes} min audio). Accept and call the user within ${instantPickupMinutes} minutes.`
          : `Audio consultation requested for ${formatSlot(b.startAt, utcOffsetMinutes, timeZoneLabel)} (${b.durationMinutes} min).`,
      createdAt: now,
      readAt: null,
      delivery: "inbox",
    });
  } catch (err) {
    logError(err, { scope: "astrologer-portal", operation: "notifyReassigned", bookingId: b.bookingId });
  }
  return placed.astrologer;
}

/**
 * The astrologer declines. A First-Out booking goes to the next astrologer
 * in the rotation; a User-Choice booking (the user picked this
 * astrologer), or one nobody else can take, is cancelled for a refund.
 */
export async function rejectRequest(astrologerId: string, bookingId: string, now = Date.now()): Promise<{ reassigned: boolean }> {
  const c = await ownConsultation(astrologerId, bookingId, now);
  if (!c.canReject) throw notChangeable(bookingId, c.status);
  const b = await ownBooking(astrologerId, bookingId);

  if (b.minutes) {
    try {
      if (await reassign(b, now)) {
        await decide(astrologerId, b, "rejected", now, "Passed to another astrologer");
        return { reassigned: true };
      }
    } catch (err) {
      if (err instanceof BookingChanged) throw notChangeable(bookingId, "changed meanwhile");
      logError(err, { scope: "astrologer-portal", operation: "reassign", bookingId });
    }
  }

  const cancelled = await getBookingStore().update(bookingId, { status: "confirmed", astrologerId }, { status: "cancelled", cancelledAt: now });
  if (!cancelled) throw notChangeable(bookingId, "changed meanwhile");
  await decide(astrologerId, b, "rejected", now, b.minutes ? "No other astrologer was free; cancelled for a refund" : "Cancelled for a refund");
  return { reassigned: false };
}

/**
 * The astrologer starts the call (accepting it if still pending). Until a
 * telephony bridge is wired in, the call is simulated as redirected through
 * the platform (the user's number is never shown) and completed at once:
 * the booking becomes the call window that just ended and a completed call
 * is recorded, so analytics and the bandit count it like a real one.
 */
export async function callNow(astrologerId: string, bookingId: string, now = Date.now()): Promise<void> {
  const c = await ownConsultation(astrologerId, bookingId, now);
  if (!c.canCall) throw notChangeable(bookingId, `can't be called now (${c.status})`);
  const b = await ownBooking(astrologerId, bookingId);
  if (c.status === "pending") await decide(astrologerId, b, "accepted", now);

  const startedAt = now - b.durationMinutes * MINUTE_MS;
  const done = await getBookingStore().update(bookingId, { status: "confirmed", astrologerId }, { connectedAt: startedAt, startAt: startedAt, endAt: now });
  if (!done) throw notChangeable(bookingId, "changed meanwhile");
  try {
    await recordCall({
      callId: bookingId,
      userId: b.userId,
      sessionId: b.sessionId,
      astrologerId,
      providerId: b.providerId,
      status: "completed",
      startedAt,
      endedAt: now,
      pricePerMinute: b.pricePerMinute,
    });
  } catch (err) {
    logError(err, { scope: "astrologer-portal", operation: "recordCall", bookingId });
  }
}
