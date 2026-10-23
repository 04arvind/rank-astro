import { config } from "@/config";
import { getAstrologerRepository } from "@/lib/astrologer";
import { listEligibleAstrologers, type DurationMinutes } from "@/lib/consultation/offers";
import { AppError, logError, NotFoundError, ProviderError, ProviderTimeoutError, SlotUnavailableError, toAppError } from "@/lib/errors";
import { fetchAvailability, getProviderAdapter } from "@/lib/providers";
import { allocateRoundRobin, filterByPreferences, getFirstOutPool } from "@/lib/ranking/first-out";
import { DAY_MS, MINUTE_MS } from "@/lib/utils/time";
import type { AstrologerProfile } from "@/types/astrologer";
import type {
  AstrologerNotification,
  Booking,
  BookingKind,
  BookingView,
  NotificationDelivery,
  Schedule,
  ScheduleDay,
  SlotStatus,
} from "@/types/booking";
import { bookingWindow, buildSchedule, isOnSchedule } from "./slots";
import { getBookingStore, getNotificationStore } from "./store";
import { formatSlot } from "./time";

/*
 * Consultation bookings: the slot calendar a user sees, booking a call,
 * and telling the astrologer about it.
 *
 * One booking = one call = one assigned astrologer. A booking targets
 * either one astrologer (User-Choice) or a duration card's pool (First-Out:
 * every eligible astrologer who takes that length); pool bookings are
 * allocated by strict round-robin across the provider sheets
 * (lib/ranking/first-out). A confirmed booking locks its astrologer and its
 * user over [startAt, endAt) — the store enforces that atomically, so a
 * stale calendar can't let a double booking through.
 *
 * "scheduled" bookings take a future slot. "instant" (talk now) bookings
 * go to an astrologer who is online and free, who must call within
 * instantPickupMinutes; one not connected by then is "missed", releases
 * the astrologer, and can be moved to a slot or cancelled for a refund.
 * A user holds at most maxUpcomingPerUser active bookings.
 */

export { buildSchedule, isOnSchedule, bookingWindow } from "./slots";
export * from "./store";
export * from "./time";

/** A single astrologer, or a duration card's price pool. */
export type BookingTarget = { astrologerId: string } | { minutes: DurationMinutes };

const FOREVER = Number.MAX_SAFE_INTEGER;
/** How long a missed instant call stays offered for rescheduling / refund. */
const MISSED_VISIBLE_MS = DAY_MS;

async function astrologerOrThrow(astrologerId: string): Promise<AstrologerProfile> {
  const [astrologer] = await getAstrologerRepository().getByIds([astrologerId]);
  if (!astrologer) throw new NotFoundError("astrologer", astrologerId);
  return astrologer;
}

const targetKey = (t: BookingTarget) => ("astrologerId" in t ? t.astrologerId : `pool:${t.minutes}`);

/** A chosen astrologer, or the First-Out pool narrowed to the user's topic and language (before the rotation runs). */
async function candidatesFor(target: BookingTarget, now: number, preferences?: Booking["preferences"]): Promise<AstrologerProfile[]> {
  return "astrologerId" in target
    ? [await astrologerOrThrow(target.astrologerId)]
    : filterByPreferences(await getFirstOutPool(target.minutes, now), preferences);
}

const isMissed = (b: Booking, now: number) =>
  b.kind === "instant" && b.status === "confirmed" && !b.connectedAt && b.pickupBy !== undefined && now > b.pickupBy;

/* ───────────────────────────── calendars ───────────────────────────── */

export async function getSchedule(astrologerId: string, userId?: string, now = Date.now()): Promise<Schedule> {
  await astrologerOrThrow(astrologerId);
  const rules = config.booking;
  const range = { from: now, to: bookingWindow(rules, now).to };
  const store = getBookingStore();
  const [astrologerBookings, userBookings] = await Promise.all([
    store.list({ astrologerId, ...range }),
    userId ? store.list({ userId, ...range }) : Promise.resolve([]),
  ]);
  return {
    astrologerId,
    slotMinutes: rules.slotMinutes,
    utcOffsetMinutes: rules.utcOffsetMinutes,
    timeZoneLabel: rules.timeZoneLabel,
    days: buildSchedule({ astrologerId, userId, astrologerBookings, userBookings }, rules, now),
  };
}

/** What one slot is for the user, given what it is with each pool astrologer. */
function poolStatus(statuses: SlotStatus[]): SlotStatus {
  if (statuses.includes("yours")) return "yours";
  if (statuses.includes("available")) return "available";
  if (statuses.includes("userBusy")) return "userBusy";
  return "unavailable";
}

/** Pool astrologers who can take a talk-now call right now: online (live status when the provider has it) and not booked over the call window. */
async function instantCandidates(pool: AstrologerProfile[], minutes: number, now: number): Promise<AstrologerProfile[]> {
  if (pool.length === 0) return [];
  const live = await fetchAvailability(pool, now);
  const online = pool.filter((a) => (live.get(a.id)?.status ?? a.availability.status) === "online");
  if (online.length === 0) return [];
  const end = now + (config.booking.instantPickupMinutes + minutes) * MINUTE_MS;
  const busy = new Set((await getBookingStore().list({ from: now, to: end })).map((b) => b.astrologerId));
  return online.filter((a) => !busy.has(a.id));
}

/**
 * A duration card's calendar: a slot is available if at least one pool
 * astrologer is free then (working hours, not booked), plus whether a
 * talk-now call can be placed right now.
 */
export async function getPoolSchedule(minutes: DurationMinutes, userId?: string, now = Date.now()): Promise<Schedule> {
  const rules = config.booking;
  const range = { from: now, to: bookingWindow(rules, now).to };
  const store = getBookingStore();
  const [pool, all, userBookings] = await Promise.all([
    getFirstOutPool(minutes, now),
    store.list(range),
    userId ? store.list({ userId, ...range }) : Promise.resolve([]),
  ]);

  const perAstrologer = pool.map((a) =>
    buildSchedule({ astrologerId: a.id, userId, astrologerBookings: all.filter((b) => b.astrologerId === a.id), userBookings }, rules, now),
  );
  // The bare grid (past / too soon), used as-is when nobody is in the pool.
  const grid = buildSchedule({ astrologerId: "", astrologerBookings: [], userBookings: [] }, rules, now);
  const days: ScheduleDay[] = grid.map((day, d) => ({
    date: day.date,
    slots: day.slots.map((slot, i) => ({
      ...slot,
      status: perAstrologer.length ? poolStatus(perAstrologer.map((s) => s[d].slots[i].status)) : "unavailable",
    })),
  }));

  const instant = await instantCandidates(pool, minutes, now);
  return {
    astrologerId: targetKey({ minutes }),
    slotMinutes: rules.slotMinutes,
    utcOffsetMinutes: rules.utcOffsetMinutes,
    timeZoneLabel: rules.timeZoneLabel,
    days,
    instant: { available: instant.length > 0, pickupMinutes: rules.instantPickupMinutes },
  };
}

/* ───────────────────────────── the user's booking ───────────────────────────── */

export function toBookingView(b: Booking): BookingView {
  const { utcOffsetMinutes, timeZoneLabel } = config.booking;
  const mode: BookingKind = b.kind ?? "scheduled";
  const state: BookingView["state"] =
    b.status === "cancelled"
      ? "cancelled"
      : b.status === "expired"
        ? "missed"
        : b.connectedAt
          ? "connected"
          : mode === "instant"
            ? "awaiting_call"
            : "upcoming";
  return {
    bookingId: b.bookingId,
    mode,
    state,
    startAt: b.startAt,
    endAt: b.endAt,
    pickupBy: b.pickupBy ?? null,
    minutes: b.minutes ?? null,
    label: formatSlot(b.startAt, utcOffsetMinutes, timeZoneLabel),
    issue: b.issue ?? null,
  };
}

/** The user's confirmed bookings that haven't ended; missed instant calls are expired on the way (freeing their astrologer). */
async function activeBookings(userId: string, now: number): Promise<Booking[]> {
  const store = getBookingStore();
  const upcoming = await store.list({ userId, from: now, to: FOREVER });
  const active: Booking[] = [];
  for (const b of upcoming) {
    if (isMissed(b, now)) await store.update(b.bookingId, { status: "confirmed" }, { status: "expired" });
    else active.push(b);
  }
  return active;
}

/**
 * If a scheduled pool booking's astrologer is no longer eligible, hands it
 * to another pool astrologer free at that time; if nobody is, flags it so
 * the user is offered a reschedule or refund.
 */
async function ensureAssigned(b: Booking, now: number): Promise<Booking> {
  if (b.kind === "instant" || b.connectedAt || b.startAt <= now) return b;
  const eligible = new Set((await listEligibleAstrologers(now)).map((a) => a.id));
  if (eligible.has(b.astrologerId)) return b;

  const store = getBookingStore();
  const pool = b.minutes ? filterByPreferences(await getFirstOutPool(b.minutes as DurationMinutes, now), b.preferences) : [];
  for (const a of pool) {
    if (a.id === b.astrologerId) continue;
    try {
      const moved = await store.update(
        b.bookingId,
        { status: "confirmed", astrologerId: b.astrologerId },
        { astrologerId: a.id, providerId: a.providerId, pricePerMinute: a.pricing.perMinute, issue: null },
      );
      if (!moved) return (await store.get(b.bookingId)) ?? b;
      await notifyAstrologer(moved, a, now);
      return moved;
    } catch (err) {
      if (!(err instanceof SlotUnavailableError && err.reason === "astrologer_busy")) throw err;
    }
  }
  if (b.issue === "astrologer_unavailable") return b;
  return (await store.update(b.bookingId, { status: "confirmed", astrologerId: b.astrologerId }, { issue: "astrologer_unavailable" })) ?? b;
}

/** The booking to show the user: their active one, else a recently missed instant call still awaiting a decision. */
export async function getCurrentBooking(userId: string, now = Date.now()): Promise<BookingView | null> {
  const [active] = await activeBookings(userId, now);
  if (active) return toBookingView(await ensureAssigned(active, now));
  const missed = (await getBookingStore().list({ userId, from: now - MISSED_VISIBLE_MS, to: FOREVER, statuses: ["expired"] })).filter(
    (b) => b.kind === "instant",
  );
  const last = missed[missed.length - 1];
  return last ? toBookingView(last) : null;
}

/* ───────────────────────────── booking ───────────────────────────── */

export interface CreateBookingInput {
  userId: string;
  sessionId?: string;
  mode: BookingKind;
  /** Slot start; scheduled only. */
  startAt?: number;
  target: BookingTarget;
  /** Duration card: the topic and language picked on the form; First-Out only assigns astrologers matching them. */
  preferences?: Booking["preferences"];
}

async function assertNoActiveBooking(userId: string, now: number): Promise<void> {
  const active = await activeBookings(userId, now);
  if (active.length >= config.booking.maxUpcomingPerUser) {
    throw new AppError("ACTIVE_BOOKING_EXISTS", `User has ${active.length} active bookings`, {
      details: { userId },
      publicDetails: { bookingId: active[0].bookingId },
    });
  }
}

/** Books the first candidate the store accepts; a busy candidate moves on to the next. */
async function placeWithFirstFree(
  candidates: AstrologerProfile[],
  draft: (a: AstrologerProfile) => Booking,
  none: () => Error,
): Promise<{ booking: Booking; astrologer: AstrologerProfile }> {
  for (const a of candidates) {
    const booking = draft(a);
    try {
      await getBookingStore().create(booking);
      return { booking, astrologer: a };
    } catch (err) {
      if (!(err instanceof SlotUnavailableError && err.reason === "astrologer_busy")) throw err;
    }
  }
  throw none();
}

/** First-Out: books the next astrologer in the round-robin rotation who is free, advancing it. */
async function placeRoundRobin(
  candidates: AstrologerProfile[],
  draft: (a: AstrologerProfile) => Booking,
  none: () => Error,
): Promise<{ booking: Booking; astrologer: AstrologerProfile }> {
  const placed = await allocateRoundRobin(candidates, async (a) => {
    const booking = draft(a);
    try {
      await getBookingStore().create(booking);
      return booking;
    } catch (err) {
      if (err instanceof SlotUnavailableError && err.reason === "astrologer_busy") return null;
      throw err;
    }
  });
  if (!placed) throw none();
  return { booking: placed.result, astrologer: placed.astrologer };
}

type Placer = typeof placeWithFirstFree;

function draftBooking(
  a: AstrologerProfile,
  input: { userId: string; sessionId?: string; target: BookingTarget; preferences?: Booking["preferences"] },
  when: { kind: BookingKind; startAt: number; endAt: number; durationMinutes: number; pickupBy?: number },
  now: number,
): Booking {
  return {
    bookingId: crypto.randomUUID(),
    astrologerId: a.id,
    providerId: a.providerId,
    userId: input.userId,
    sessionId: input.sessionId,
    mode: "audio",
    pricePerMinute: a.pricing.perMinute,
    status: "confirmed",
    createdAt: now,
    minutes: "minutes" in input.target ? input.target.minutes : undefined,
    ...("minutes" in input.target && input.preferences ? { preferences: input.preferences } : {}),
    connectedAt: null,
    issue: null,
    ...when,
  };
}

async function placeScheduled(
  input: { userId: string; sessionId?: string; target: BookingTarget; startAt: number },
  candidates: AstrologerProfile[],
  now: number,
  place: Placer = placeWithFirstFree,
) {
  const rules = config.booking;
  const context = { astrologerId: targetKey(input.target), startAt: input.startAt };
  if (!isOnSchedule(input.startAt, rules, now)) throw new SlotUnavailableError("outside_schedule", context);
  return place(
    candidates,
    (a) =>
      draftBooking(a, input, { kind: "scheduled", startAt: input.startAt, endAt: input.startAt + rules.slotMinutes * MINUTE_MS, durationMinutes: rules.slotMinutes }, now),
    () => new SlotUnavailableError("astrologer_busy", context),
  );
}

export async function createBooking(
  input: CreateBookingInput,
  now = Date.now(),
): Promise<{ booking: Booking; notification: AstrologerNotification | null }> {
  const rules = config.booking;
  await assertNoActiveBooking(input.userId, now);
  const pool = await candidatesFor(input.target, now, input.preferences);
  // Duration cards (First-Out) rotate across the sheets; a chosen astrologer is booked directly.
  const place: Placer = "minutes" in input.target ? placeRoundRobin : placeWithFirstFree;

  let placed: { booking: Booking; astrologer: AstrologerProfile };
  if (input.mode === "scheduled") {
    if (input.startAt === undefined) throw new SlotUnavailableError("outside_schedule", { astrologerId: targetKey(input.target), startAt: 0 });
    placed = await placeScheduled({ ...input, startAt: input.startAt }, pool, now, place);
  } else {
    const minutes = "minutes" in input.target ? input.target.minutes : rules.slotMinutes;
    const candidates = await instantCandidates(pool, minutes, now);
    const pickupBy = now + rules.instantPickupMinutes * MINUTE_MS;
    placed = await place(
      candidates,
      (a) => draftBooking(a, input, { kind: "instant", startAt: now, endAt: pickupBy + minutes * MINUTE_MS, durationMinutes: minutes, pickupBy }, now),
      () => new AppError("NO_ASTROLOGER_AVAILABLE", `No free online astrologer for ${targetKey(input.target)}`),
    );
  }

  const notification = await notifyAstrologer(placed.booking, placed.astrologer, now);
  return { booking: placed.booking, notification };
}

async function ownBooking(bookingId: string, userId: string): Promise<Booking> {
  const b = await getBookingStore().get(bookingId);
  if (!b || b.userId !== userId) throw new NotFoundError("booking", bookingId);
  return b;
}

const notChangeable = (b: Booking, why: string) =>
  new AppError("BOOKING_NOT_CHANGEABLE", `Booking ${b.bookingId} can't be changed: ${why}`, { details: { bookingId: b.bookingId, status: b.status } });

/** Whether the user may still cancel or move the booking: not started, not connected, not already cancelled. */
function assertChangeable(b: Booking, now: number): void {
  if (b.status === "cancelled") throw notChangeable(b, "cancelled");
  if (b.connectedAt) throw notChangeable(b, "call connected");
  if (b.status === "confirmed" && (b.kind ?? "scheduled") === "scheduled" && b.startAt <= now) throw notChangeable(b, "call time reached");
}

/** Cancels the booking (a missed instant call included); the payment side refunds it. */
export async function cancelBooking(bookingId: string, userId: string, now = Date.now()): Promise<BookingView> {
  const b = await ownBooking(bookingId, userId);
  assertChangeable(b, now);
  const done = await getBookingStore().update(b.bookingId, { status: b.status }, { status: "cancelled", cancelledAt: now });
  if (!done) throw notChangeable(b, "changed meanwhile");
  return toBookingView(done);
}

/**
 * Moves a scheduled booking (or a missed instant call) to a slot, keeping its
 * payment: the old booking is released first, and restored if no one can
 * take the new slot. The mode becomes "scheduled".
 */
export async function rescheduleBooking(bookingId: string, userId: string, startAt: number, now = Date.now()): Promise<BookingView> {
  const b = await ownBooking(bookingId, userId);
  assertChangeable(b, now);
  // A pending talk-now call can only be cancelled: no switching modes after payment. A missed one may move to a slot.
  if (b.kind === "instant" && b.status === "confirmed") throw notChangeable(b, "instant call pending");
  const target: BookingTarget = b.minutes ? { minutes: b.minutes as DurationMinutes } : { astrologerId: b.astrologerId };
  const pool = await candidatesFor(target, now, b.preferences);
  // Keep the same astrologer when they're free then.
  const candidates = [...pool.filter((a) => a.id === b.astrologerId), ...pool.filter((a) => a.id !== b.astrologerId)];

  const store = getBookingStore();
  const released = await store.update(b.bookingId, { status: b.status }, { status: "cancelled", cancelledAt: now });
  if (!released) throw notChangeable(b, "changed meanwhile");
  try {
    const { booking, astrologer } = await placeScheduled({ userId, sessionId: b.sessionId, target, startAt }, candidates, now);
    await notifyAstrologer(booking, astrologer, now);
    return toBookingView(booking);
  } catch (err) {
    try {
      await store.update(b.bookingId, { status: "cancelled" }, { status: b.status });
    } catch (restoreErr) {
      logError(restoreErr, { scope: "booking", operation: "rescheduleRestore", bookingId: b.bookingId });
    }
    throw err;
  }
}

/** The provider integration reports that the astrologer connected the call. */
export async function markConnected(bookingId: string, now = Date.now()): Promise<BookingView> {
  const store = getBookingStore();
  const b = await store.get(bookingId);
  if (!b) throw new NotFoundError("booking", bookingId);
  const done = await store.update(bookingId, { status: "confirmed" }, { connectedAt: now });
  if (!done) throw notChangeable(b, `status ${b.status}`);
  return toBookingView(done);
}

/**
 * Stores the new-booking notice in the astrologer's inbox and, if their
 * provider has a push API, sends it there too. The booking is already
 * saved, so failures are logged (a failed push is also recorded on the
 * notice) and never fail it; null means the inbox write failed.
 */
async function notifyAstrologer(booking: Booking, astrologer: AstrologerProfile, now: number): Promise<AstrologerNotification | null> {
  const { utcOffsetMinutes, timeZoneLabel } = config.booking;
  const when = formatSlot(booking.startAt, utcOffsetMinutes, timeZoneLabel);
  const instant = booking.kind === "instant";
  const title = instant ? "Talk-now call requested" : "New consultation booked";
  const message = instant
    ? `Please call the user within ${config.booking.instantPickupMinutes} minutes (${booking.durationMinutes} min audio consultation).`
    : `Audio consultation scheduled for ${when} (${booking.durationMinutes} min).`;

  let delivery: NotificationDelivery = "inbox";
  const push = getProviderAdapter(astrologer.providerId)?.notifyBooking;
  if (push) {
    const { timeoutMs } = config.providers.availability;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      await push(
        {
          astrologerNativeId: astrologer.externalId ?? astrologer.sourceId,
          bookingId: booking.bookingId,
          startAt: booking.startAt,
          endAt: booking.endAt,
          title,
          message,
        },
        signal,
      );
      delivery = "sent";
    } catch (err) {
      delivery = "failed";
      const context = { providerId: astrologer.providerId, operation: "notifyBooking", bookingId: booking.bookingId };
      const error = signal.aborted
        ? new ProviderTimeoutError({ ...context, timeoutMs }, { cause: err })
        : toAppError(err, (cause) => new ProviderError("Booking notification failed", context, { cause }));
      logError(error, { scope: "booking" });
    }
  }

  const notification: AstrologerNotification = {
    notificationId: crypto.randomUUID(),
    astrologerId: astrologer.id,
    providerId: astrologer.providerId,
    type: "booking.scheduled",
    bookingId: booking.bookingId,
    scheduledStartAt: booking.startAt,
    scheduledEndAt: booking.endAt,
    title,
    message,
    createdAt: now,
    readAt: null,
    delivery,
  };
  try {
    await getNotificationStore().append(notification);
    return notification;
  } catch (err) {
    logError(err, { scope: "booking", operation: "notifyAstrologer", bookingId: booking.bookingId });
    return null;
  }
}
