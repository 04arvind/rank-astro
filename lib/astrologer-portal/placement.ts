import { createBooking, getBookingStore, type CreateBookingInput } from "@/lib/booking";
import { logError } from "@/lib/errors";
import { claimPayment, releasePayment, settlePayment, type Payment } from "@/lib/payments";
import type { AstrologerNotification, Booking } from "@/types/booking";
import { getRequestStore, requestFor, type RequestDetails } from "./requests";

/*
 * Booking from the Pay button: books through the existing booking flow
 * (which picks the astrologer — the First-Out rotation for a /user
 * duration card, the user's own pick for User-Choice) and files the
 * request the assigned astrologer sees, with the user's details.
 *
 * `requestKey` makes it idempotent: the same key (a repeated click, a
 * retried request) returns the booking it already made instead of a
 * second one. Same-key calls in this process run one at a time.
 *
 * First-Out bookings are paid first (`placePaidBooking`): the payment is
 * claimed for the attempt, its id is the request key, and it is spent on
 * the booking — so one payment can't book, or take a rotation turn, twice.
 */

export interface PlaceRequestInput extends CreateBookingInput {
  details: RequestDetails;
  requestKey?: string;
  payment?: Payment;
}

export interface PlacedRequest {
  booking: Booking;
  notification: AstrologerNotification | null;
  /** True when `requestKey` had already booked; nothing new was created. */
  replayed: boolean;
}

const g = globalThis as unknown as { __requestKeys?: Map<string, Promise<PlacedRequest>> };
const inFlight: Map<string, Promise<PlacedRequest>> = (g.__requestKeys ??= new Map());

async function replay(requestKey: string): Promise<PlacedRequest | null> {
  const existing = await getRequestStore().byKey(requestKey);
  if (!existing) return null;
  const booking = await getBookingStore().get(existing.bookingId);
  return booking ? { booking, notification: null, replayed: true } : null;
}

async function place(input: PlaceRequestInput, now: number): Promise<PlacedRequest> {
  if (input.requestKey) {
    const done = await replay(input.requestKey);
    if (done) return done;
  }

  const { details, requestKey, payment, ...create } = input;
  const source = "minutes" in create.target ? "first_out" : "user_choice";
  // First-Out assigns only astrologers matching the topic and language picked on the form.
  const preferences = source === "first_out" ? { topic: details.topic, language: details.language } : undefined;
  const { booking, notification } = await createBooking({ ...create, preferences }, now);
  const paid = payment ? { paymentId: payment.paymentId, amount: payment.amount, status: "paid" as const } : undefined;
  try {
    await getRequestStore().put({ ...requestFor(booking, details, { source, requestKey, now }), ...(paid ? { payment: paid } : {}) });
  } catch (err) {
    // The booking stands; the astrologer still sees it, just without the user's details.
    logError(err, { scope: "astrologer-portal", operation: "fileRequest", bookingId: booking.bookingId });
  }
  return { booking, notification, replayed: false };
}

export function placeBookingRequest(input: PlaceRequestInput, now = Date.now()): Promise<PlacedRequest> {
  const key = input.requestKey;
  if (!key) return place(input, now);
  const running = inFlight.get(key);
  if (running) return running.then((r) => ({ ...r, notification: null, replayed: true }));
  const run = place(input, now).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

export const paymentRequestKey = (paymentId: string) => `pay:${paymentId}`;

/**
 * A First-Out booking against a paid payment. A payment that already
 * booked returns that booking; one booking right now elsewhere is refused;
 * a failed booking releases the payment so the user can pick another slot
 * without paying again.
 */
export async function placePaidBooking(
  input: Omit<PlaceRequestInput, "requestKey" | "payment"> & { paymentId: string; target: { minutes: number } },
  now = Date.now(),
): Promise<PlacedRequest & { payment: Payment }> {
  const requestKey = paymentRequestKey(input.paymentId);
  const claim = await claimPayment(input.paymentId, input.userId, input.target.minutes, now);
  if (claim.kind === "booked") {
    const done = await replay(requestKey);
    if (done) return { ...done, payment: claim.payment };
  }

  const { paymentId, ...rest } = input;
  try {
    const placed = await placeBookingRequest({ ...rest, requestKey, payment: claim.payment }, now);
    await settlePayment(paymentId, placed.booking.bookingId, now);
    return { ...placed, payment: { ...claim.payment, bookingId: placed.booking.bookingId } };
  } catch (err) {
    await releasePayment(paymentId, now);
    throw err;
  }
}
