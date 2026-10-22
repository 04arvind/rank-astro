import type { NextRequest } from "next/server";
import { z } from "zod";
import { placeBookingRequest, placePaidBooking } from "@/lib/astrologer-portal/placement";
import { cancelBooking, getCurrentBooking, markConnected, rescheduleBooking, type BookingTarget } from "@/lib/booking";
import { DURATIONS } from "@/lib/consultation/offers";
import { requireAdmin } from "../_lib/auth";
import { handle, ok } from "../_lib/http";
import { parseJsonBody, parseQuery } from "../_lib/validation";

/*
 * Bookings — one booking = one call = one assigned astrologer.
 *
 * POST  { userId, sessionId?, mode: "instant" | "scheduled", slot_time?,
 *         astrologerId? | minutes? } — books a call. `slot_time` (epoch ms,
 *         from GET /api/bookings/slots) is required for scheduled and not
 *         allowed for instant; `startAt` is accepted as its older name.
 *         `astrologerId` books that astrologer (User-Choice); `minutes`
 *         books a /user duration card (First-Out), which must be paid
 *         first: `paymentId` from POST /api/payments. The astrologer is
 *         assigned by the First-Out round-robin, and the payment is the
 *         idempotency key (a payment books once). Duration
 *         and price come from config and the astrologer's profile, never
 *         the client. Optional `details` { name, mobile, city (together),
 *         topic, language } go to the assigned astrologer's request; an optional
 *         `requestKey` (one per Pay click) makes the call idempotent: the
 *         same key returns the booking it already made (`replayed: true`).
 *         409 SLOT_UNAVAILABLE: the slot was taken meanwhile — refetch.
 *         409 ACTIVE_BOOKING_EXISTS: the user already has a call booked
 *             (error.details.bookingId) — reschedule or cancel it.
 *         409 NO_ASTROLOGER_AVAILABLE: nobody can take a talk-now call.
 * GET   ?userId=… — { booking }: the user's active booking, or a recently
 *         missed talk-now call, or null.
 * PATCH { action: "cancel", bookingId, userId }
 *       { action: "reschedule", bookingId, userId, slot_time }
 *       { action: "connected", bookingId } — provider integration (admin key)
 */

const id = z.string().trim().min(1).max(128);
const time = z.number().int().nonnegative();
const text = (max: number) => z.string().trim().min(1).max(max);
// The contact fields come together (duration-card form) or not at all (astrologer card).
const detailsSchema = z
  .object({
    name: text(60).optional(),
    mobile: z.string().trim().regex(/^[6-9]\d{9}$/, "a 10-digit mobile number").optional(),
    city: text(60).optional(),
    topic: text(60).optional(),
    language: text(40).optional(),
  })
  .refine((d) => [d.name, d.mobile, d.city].every((v) => v === undefined) || [d.name, d.mobile, d.city].every((v) => v !== undefined), {
    message: "name, mobile and city go together",
  });

const minutes = z
  .number()
  .int()
  .refine((m) => (DURATIONS as readonly number[]).includes(m), { message: `minutes must be one of ${DURATIONS.join(", ")}` });

const bodySchema = z
  .object({
    userId: id,
    sessionId: id.optional(),
    mode: z.enum(["instant", "scheduled"]).default("scheduled"),
    slot_time: time.optional(),
    startAt: time.optional(),
    astrologerId: id.optional(),
    minutes: minutes.optional(),
    details: detailsSchema.optional(),
    requestKey: z.string().trim().min(8).max(128).optional(),
    paymentId: id.optional(),
  })
  .transform(({ startAt, slot_time, ...b }) => ({ ...b, slotTime: slot_time ?? startAt }))
  .refine((b) => (b.astrologerId === undefined) !== (b.minutes === undefined), { message: "Pass exactly one of astrologerId or minutes" })
  .refine((b) => (b.minutes !== undefined) === (b.paymentId !== undefined), {
    message: "Duration-card bookings need a paymentId (pay first); astrologer bookings don't take one",
    path: ["paymentId"],
  })
  .refine((b) => (b.mode === "scheduled") === (b.slotTime !== undefined), {
    message: "slot_time is required for scheduled bookings and not allowed for instant ones",
    path: ["slot_time"],
  });

const querySchema = z.object({ userId: id });

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel"), bookingId: id, userId: id }),
  z.object({ action: z.literal("reschedule"), bookingId: id, userId: id, slot_time: time }),
  z.object({ action: z.literal("connected"), bookingId: id }),
]);

export const POST = handle(async (req: NextRequest, { requestId }) => {
  const body = await parseJsonBody(req, bodySchema);
  const target: BookingTarget =
    body.astrologerId !== undefined ? { astrologerId: body.astrologerId } : { minutes: body.minutes as (typeof DURATIONS)[number] };
  const d = body.details;
  const common = {
    userId: body.userId,
    sessionId: body.sessionId,
    mode: body.mode,
    startAt: body.slotTime,
    details: {
      customer: d?.name && d.mobile && d.city ? { name: d.name, mobile: d.mobile, city: d.city } : null,
      topic: d?.topic ?? null,
      language: d?.language ?? null,
    },
  };
  const placed =
    "minutes" in target && body.paymentId
      ? await placePaidBooking({ ...common, target, paymentId: body.paymentId })
      : { ...(await placeBookingRequest({ ...common, target, requestKey: body.requestKey })), payment: null };
  const { booking, notification, replayed, payment } = placed;
  return ok(
    {
      bookingId: booking.bookingId,
      astrologerId: booking.astrologerId,
      mode: booking.kind ?? "scheduled",
      startAt: booking.startAt,
      endAt: booking.endAt,
      pickupBy: booking.pickupBy ?? null,
      durationMinutes: booking.durationMinutes,
      pricePerMinute: booking.pricePerMinute,
      status: booking.status,
      astrologerNotified: replayed || notification !== null,
      replayed,
      payment: payment ? { paymentId: payment.paymentId, amount: payment.amount, status: payment.status } : null,
    },
    { requestId },
    { status: replayed ? 200 : 201 },
  );
});

export const GET = handle(async (req: NextRequest, { requestId }) => {
  const q = parseQuery(req, querySchema);
  return ok({ booking: await getCurrentBooking(q.userId) }, { requestId });
});

export const PATCH = handle(async (req: NextRequest, { requestId }) => {
  const body = await parseJsonBody(req, patchSchema);
  if (body.action === "connected") {
    requireAdmin(req);
    return ok({ booking: await markConnected(body.bookingId) }, { requestId });
  }
  const booking =
    body.action === "cancel"
      ? await cancelBooking(body.bookingId, body.userId)
      : await rescheduleBooking(body.bookingId, body.userId, body.slot_time);
  return ok({ booking }, { requestId });
});
