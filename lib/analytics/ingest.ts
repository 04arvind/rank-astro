import { z } from "zod";
import { ValidationError } from "@/lib/errors";
import { parseOrThrow } from "@/lib/utils/validation";

/*
 * Input schemas for recording events. Every record* function validates
 * through these so the store only ever holds well-formed facts.
 */

const id = z.string().trim().min(1).max(128);
const timestamp = z.union([z.number().int().nonnegative(), z.iso.datetime().transform((s) => Date.parse(s))]);

const base = {
  eventId: id.optional(),
  timestamp: timestamp.optional(),
  sessionId: id.optional(),
  userId: id.optional(),
};

export const impressionInput = z.object({
  ...base,
  astrologerId: id,
  providerId: id,
  position: z.number().int().positive(),
  requestId: id.optional(),
  engineVersion: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  /** Where it was shown, e.g. a home-feed column id. */
  placement: z.string().max(32).optional(),
});

export const clickInput = z.object({
  ...base,
  astrologerId: id,
  providerId: id,
  position: z.number().int().positive().optional(),
  requestId: id.optional(),
  placement: z.string().max(32).optional(),
});

export const callInput = z
  .object({
    ...base,
    callId: id,
    userId: id,
    astrologerId: id,
    providerId: id,
    status: z.enum(["completed", "missed", "rejected", "failed"]),
    startedAt: timestamp,
    endedAt: timestamp,
    pricePerMinute: z.number().nonnegative(),
    /** Defaults to billed minutes × price when the provider doesn't send it. */
    grossAmount: z.number().nonnegative().optional(),
    requestId: id.optional(),
  })
  .refine((c) => c.endedAt >= c.startedAt, { message: "endedAt must be >= startedAt", path: ["endedAt"] });

export const ratingInput = z.object({
  ...base,
  callId: id,
  userId: id,
  astrologerId: id,
  providerId: id,
  rating: z.number().min(1).max(5),
  complaint: z.boolean().default(false),
});

export type ImpressionInput = z.input<typeof impressionInput>;
export type ClickInput = z.input<typeof clickInput>;
export type CallInput = z.input<typeof callInput>;
export type RatingInput = z.input<typeof ratingInput>;

export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  return parseOrThrow(schema, input, (issues) => new ValidationError("Invalid analytics event", issues));
}

/** Fills eventId / timestamp defaults shared by every event type. */
export function withMeta<T extends { eventId?: string; timestamp?: number }>(
  input: T,
  fallbackTimestamp = Date.now(),
): T & { eventId: string; timestamp: number } {
  return {
    ...input,
    eventId: input.eventId ?? crypto.randomUUID(),
    timestamp: input.timestamp ?? fallbackTimestamp,
  };
}
