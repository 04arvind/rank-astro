import { z } from "zod";
import { config } from "@/config";
import { clickInput } from "@/lib/analytics";
import type {
  RankingContext,
  RankingDebugRequest,
  RankingStatsQuery,
} from "@/types/ranking";

/*
 * Request shapes only: these describe what a client may send, not how
 * ranking works. Limits come from config.ranking.pagination.
 */

const id = z.string().trim().min(1).max(128);
const tag = z.string().trim().toLowerCase().min(1).max(64);
const toArray = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (v === undefined || Array.isArray(v) ? v : [v]), z.array(item).max(50));

const { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT } = config.ranking.pagination;

const priceRange = z
  .object({
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
  })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
    message: "min must be <= max",
  });

export const rankBodySchema = z.object({
  user: z
    .object({ userId: id.optional(), sessionId: id.optional() })
    .default({}),
  context: z
    .object({
      category: tag.optional(),
      specialization: tag.optional(),
      languages: z.array(tag).max(20).optional(),
      priceRange: priceRange.optional(),
      platform: z.enum(["web", "android", "ios"]).optional(),
    })
    .default({}),
  filters: z
    .object({
      onlineOnly: z.boolean().default(false),
      providerIds: z.array(id).max(50).optional(),
    })
    .default({ onlineOnly: false }),
  pagination: z
    .object({
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      offset: z.number().int().min(0).default(0),
    })
    .default({ limit: DEFAULT_LIMIT, offset: 0 }),
}) satisfies z.ZodType<RankingContext, unknown>;

/** Flat query-string variant of the rank request, for simple GET clients. */
export const rankQuerySchema = z
  .object({
    userId: id.optional(),
    sessionId: id.optional(),
    category: tag.optional(),
    specialization: tag.optional(),
    languages: toArray(tag).optional(),
    minPrice: z.coerce.number().nonnegative().optional(),
    maxPrice: z.coerce.number().nonnegative().optional(),
    platform: z.enum(["web", "android", "ios"]).optional(),
    onlineOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    providerIds: toArray(id).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine(
    (q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice,
    { message: "minPrice must be <= maxPrice", path: ["minPrice"] },
  )
  .transform(
    (q): RankingContext => ({
      user: { userId: q.userId, sessionId: q.sessionId },
      context: {
        category: q.category,
        specialization: q.specialization,
        languages: q.languages,
        priceRange:
          q.minPrice !== undefined || q.maxPrice !== undefined
            ? { min: q.minPrice, max: q.maxPrice }
            : undefined,
        platform: q.platform,
      },
      filters: { onlineOnly: q.onlineOnly ?? false, providerIds: q.providerIds },
      pagination: { limit: q.limit, offset: q.offset },
    }),
  );

export const debugBodySchema = rankBodySchema.extend({
  astrologerIds: z.array(id).max(200).optional(),
}) satisfies z.ZodType<RankingDebugRequest, unknown>;

export const statsQuerySchema = z.object({
  window: z.enum(["1h", "24h", "7d", "30d"]).default("24h"),
  providerId: id.optional(),
}) satisfies z.ZodType<RankingStatsQuery, unknown>;

/*
 * Client-submitted analytics. Only clicks for now: impressions are logged
 * server-side by the rank route, and calls/ratings must come from trusted
 * provider callbacks, never the browser. The server assigns ids and timestamps.
 */
const clientClick = clickInput
  .omit({ eventId: true, timestamp: true })
  .extend({ type: z.literal("click") });

export const clientEventsSchema = z.object({
  events: z
    .array(z.discriminatedUnion("type", [clientClick]))
    .min(1)
    .max(config.analytics.ingestion.maxBatchSize),
});
