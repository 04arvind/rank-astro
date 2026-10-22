import type { NextRequest } from "next/server";
import { z } from "zod";
import { DURATIONS, type DurationMinutes } from "@/lib/consultation/offers";
import { createPayment, refundUnusedPayment } from "@/lib/payments";
import { handle, ok } from "../_lib/http";
import { parseJsonBody } from "../_lib/validation";

/*
 * Payments for /user duration cards (First-Out), taken before booking.
 *
 * POST  { userId, minutes, payKey } — charges the card's price (computed
 *       here) and returns the paid payment; the same `payKey` (one per Pay
 *       click) returns the same payment, so a repeated click charges once.
 *       There's no gateway yet: the charge is recorded as paid at once.
 * PATCH { action: "refund", paymentId, userId } — the user gave up on a
 *       payment that never booked: marks it refund_due.
 */

const id = z.string().trim().min(1).max(128);
const minutes = z
  .number()
  .int()
  .refine((m) => (DURATIONS as readonly number[]).includes(m), { message: `minutes must be one of ${DURATIONS.join(", ")}` });

const postSchema = z.object({ userId: id, minutes, payKey: z.string().trim().min(8).max(128) });
const patchSchema = z.object({ action: z.literal("refund"), paymentId: id, userId: id });

const view = (p: { paymentId: string; amount: number; currency: string; status: string; bookingId: string | null }) => ({
  paymentId: p.paymentId,
  amount: p.amount,
  currency: p.currency,
  status: p.status,
  bookingId: p.bookingId,
});

export const POST = handle(async (req: NextRequest, { requestId }) => {
  const body = await parseJsonBody(req, postSchema);
  const payment = await createPayment({ userId: body.userId, minutes: body.minutes as DurationMinutes, payKey: body.payKey });
  return ok(view(payment), { requestId }, { status: 201 });
});

export const PATCH = handle(async (req: NextRequest, { requestId }) => {
  const body = await parseJsonBody(req, patchSchema);
  return ok(view(await refundUnusedPayment(body.paymentId, body.userId)), { requestId });
});
