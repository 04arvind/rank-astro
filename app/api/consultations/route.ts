import type { NextRequest } from "next/server";
import { z } from "zod";
import { recordCall, recordRating } from "@/lib/analytics";
import { getAstrologerRepository } from "@/lib/astrologer";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { handle, ok } from "../_lib/http";
import { parseJsonBody } from "../_lib/validation";

/*
 * POST /api/consultations — records the outcome of a consultation started
 * from the astrologer card, then (optionally) the user's rating of it.
 * Provider and price come from the astrologer's stored profile, never from
 * the client, and call times must be recent and bounded.
 */

const id = z.string().trim().min(1).max(128);
const MAX_CALL_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("call"),
    callId: id,
    userId: id,
    sessionId: id.optional(),
    astrologerId: id,
    status: z.enum(["completed", "missed"]),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("rating"),
    callId: id,
    userId: id,
    sessionId: id.optional(),
    astrologerId: id,
    rating: z.number().int().min(1).max(5),
    complaint: z.boolean().default(false),
  }),
]);

export const POST = handle(async (req: NextRequest, { requestId }) => {
  const body = await parseJsonBody(req, bodySchema);
  const [astrologer] = await getAstrologerRepository().getByIds([body.astrologerId]);
  if (!astrologer) throw new NotFoundError("astrologer", body.astrologerId);

  if (body.action === "rating") {
    const event = await recordRating({
      callId: body.callId,
      userId: body.userId,
      sessionId: body.sessionId,
      astrologerId: astrologer.id,
      providerId: astrologer.providerId,
      rating: body.rating,
      complaint: body.complaint,
    });
    return ok({ eventId: event.eventId }, { requestId }, { status: 201 });
  }

  const now = Date.now();
  if (body.endedAt < body.startedAt || body.endedAt > now + CLOCK_SKEW_MS || body.endedAt - body.startedAt > MAX_CALL_MS || now - body.startedAt > MAX_CALL_MS + CLOCK_SKEW_MS) {
    throw new ValidationError("Invalid call times", [{ path: "endedAt", message: "call times must be recent and at most 2 hours long" }]);
  }

  const event = await recordCall({
    callId: body.callId,
    userId: body.userId,
    sessionId: body.sessionId,
    astrologerId: astrologer.id,
    providerId: astrologer.providerId,
    status: body.status,
    startedAt: body.startedAt,
    endedAt: body.status === "completed" ? body.endedAt : body.startedAt,
    pricePerMinute: astrologer.pricing.perMinute,
  });
  return ok(
    { eventId: event.eventId, durationSeconds: event.durationSeconds, grossAmount: event.grossAmount },
    { requestId },
    { status: 201 },
  );
});
