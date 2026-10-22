import type { NextRequest } from "next/server";
import { recordClicks } from "@/lib/analytics";
import { handle, ok } from "../../_lib/http";
import { clientEventsSchema } from "../../_lib/schemas";
import { parseJsonBody } from "../../_lib/validation";

/** POST /api/analytics/events — batch of client interaction events. */
export const POST = handle(async (req: NextRequest, { requestId }) => {
  const { events } = await parseJsonBody(req, clientEventsSchema);
  // recordClicks re-validates and strips the `type` discriminator.
  const recorded = await recordClicks(events.filter((e) => e.type === "click"));
  return ok({ accepted: recorded.length }, { requestId }, { status: 202 });
});
