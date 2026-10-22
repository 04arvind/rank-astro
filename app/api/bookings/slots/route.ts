import type { NextRequest } from "next/server";
import { z } from "zod";
import { getPoolSchedule, getSchedule } from "@/lib/booking";
import { DURATIONS } from "@/lib/consultation/offers";
import { handle, ok } from "../../_lib/http";
import { parseQuery } from "../../_lib/validation";

/**
 * GET /api/bookings/slots?astrologerId=…&userId=… — one astrologer's slot
 * calendar for the booking horizon.
 * GET /api/bookings/slots?minutes=3&userId=… — a duration card's pooled
 * calendar: a slot is available if any astrologer at the card's price is
 * free then; `instant` says whether a talk-now call can be placed now.
 * Each slot is marked available, unavailable (past / too soon / nobody
 * free), userBusy (the user has another call then) or yours (the user
 * already booked it).
 */

const id = z.string().trim().min(1).max(128);
const querySchema = z
  .object({
    astrologerId: id.optional(),
    minutes: z.coerce
      .number()
      .int()
      .refine((m) => (DURATIONS as readonly number[]).includes(m), { message: `minutes must be one of ${DURATIONS.join(", ")}` })
      .optional(),
    userId: id.optional(),
  })
  .refine((q) => (q.astrologerId === undefined) !== (q.minutes === undefined), { message: "Pass exactly one of astrologerId or minutes" });

export const GET = handle(async (req: NextRequest, { requestId }) => {
  const q = parseQuery(req, querySchema);
  const schedule =
    q.minutes !== undefined
      ? await getPoolSchedule(q.minutes as (typeof DURATIONS)[number], q.userId)
      : await getSchedule(q.astrologerId!, q.userId);
  return ok(schedule, { requestId });
});
