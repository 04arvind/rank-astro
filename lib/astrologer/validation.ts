import { z } from "zod";
import { config } from "@/config";
import { InvalidAstrologerDataError } from "@/lib/errors";
import { validate, type ValidationIssue, type ValidationResult } from "@/lib/utils/validation";
import type { AstrologerProfile, ProfileField } from "@/types/astrologer";

/*
 * Invariants every normalized astrologer must satisfy, whichever provider it
 * came from. Adapters map fields; this decides whether the result is usable.
 */

const catalogIds = (kind: "categories" | "specializations" | "languages") => {
  const ids = new Set(config.catalog[kind].map((o) => o.id));
  return z.array(z.string().refine((id) => ids.has(id), { message: `unknown ${kind} id` }));
};

const PROFILE_FIELDS = [
  "languages",
  "categories",
  "specializations",
  "experienceYears",
  "rating",
  "avatarUrl",
  "about",
  "availability",
  "consultationModes",
  "onboardedAt",
  "payout",
] as const satisfies readonly ProfileField[];

const money = z.number().nonnegative().finite();
const timestamp = z.number().int().nonnegative();

export const astrologerProfileSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9]+:[a-z0-9-]+$/, "id must be providerId:slug"),
    providerId: z.string().min(1),
    sourceId: z.string().regex(/^[a-z0-9-]+$/, "sourceId must be a non-empty slug"),
    externalId: z.string().min(1).max(128).optional(),
    name: z.string().trim().min(2, "name is required").max(120),
    tagline: z.string().max(300).optional(),
    about: z.string().max(5000).optional(),
    avatarUrl: z.url().optional(),
    profileUrl: z.url().optional(),
    languages: catalogIds("languages"),
    categories: catalogIds("categories"),
    specializations: catalogIds("specializations"),
    consultationModes: z.array(z.enum(["audio", "video", "chat"])),
    experienceYears: z.number().min(0).max(80).nullable(),
    rating: z.number().min(0).max(5).nullable(),
    reviewCount: z.number().int().nonnegative(),
    pricing: z.object({
      perMinute: z.number().positive("pricePerMinute must be > 0").finite(),
      minCallMinutes: z.number().positive().nullable(),
      packages: z.array(z.object({ minutes: z.number().positive(), price: money })),
      payoutPerMinute: money.nullable(),
    }),
    availability: z.object({
      status: z.enum(["online", "busy", "offline", "unknown"]),
      lastActiveAt: timestamp.nullable(),
    }),
    tier: z.string().max(20).optional(),
    verified: z.boolean(),
    onboardedAt: timestamp.nullable(),
    dataQuality: z.object({
      missing: z.array(z.enum(PROFILE_FIELDS)),
      unmapped: z.array(z.string()),
    }),
    source: z.object({ importedAt: timestamp, ref: z.string().optional() }),
  })
  .superRefine((a, ctx) => {
    if (!a.id.startsWith(`${a.providerId}:`)) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "id must start with providerId" });
    }
    const { perMinute, payoutPerMinute } = a.pricing;
    if (payoutPerMinute !== null && payoutPerMinute > perMinute) {
      ctx.addIssue({ code: "custom", path: ["pricing", "payoutPerMinute"], message: "payout exceeds user price" });
    }
  }) satisfies z.ZodType<AstrologerProfile>;

export type { ValidationIssue };

export function validateAstrologer(candidate: unknown): ValidationResult<AstrologerProfile> {
  return validate(astrologerProfileSchema, candidate);
}

/** Like validateAstrologer, but throws InvalidAstrologerDataError. */
export function assertValidAstrologer(candidate: unknown, context: { providerId?: string; ref?: string } = {}): AstrologerProfile {
  const r = validateAstrologer(candidate);
  if (!r.ok) throw new InvalidAstrologerDataError("Astrologer failed common-model validation", { ...context, issues: r.issues });
  return r.value;
}
