import { z } from "zod";
import { analyticsConfig } from "./analytics.config";
import { bookingConfig } from "./booking.config";
import { businessConfig } from "./business.config";
import { catalogConfig } from "./catalog.config";
import { eligibilityConfig } from "./eligibility.config";
import { explorationConfig } from "./exploration.config";
import { feedConfig } from "./feed.config";
import { providerConfig } from "./provider.config";
import { rankingConfig } from "./ranking.config";
import { userConfig } from "./user.config";
import {
  analyticsSchema,
  bookingSchema,
  businessSchema,
  catalogSchema,
  eligibilitySchema,
  explorationSchema,
  feedSchema,
  providersSchema,
  rankingSchema,
  userSchema,
} from "./schema";

export * from "./schema";

const appConfigSchema = z
  .object({
    catalog: catalogSchema,
    ranking: rankingSchema,
    eligibility: eligibilitySchema,
    business: businessSchema,
    providers: providersSchema,
    exploration: explorationSchema,
    analytics: analyticsSchema,
    user: userSchema,
    booking: bookingSchema,
    feed: feedSchema,
  })
  .superRefine((cfg, ctx) => {
    const { slotPositions } = cfg.exploration;
    if (slotPositions.max > cfg.ranking.pagination.maxLimit) {
      ctx.addIssue({
        code: "custom",
        message: "exploration.slotPositions.max exceeds ranking.pagination.maxLimit",
        path: ["exploration", "slotPositions", "max"],
      });
    }
    const { budgetMax, standardMax } = cfg.business.priceBands;
    const { min, max } = cfg.eligibility.price.perMinute;
    if (budgetMax < min || standardMax > max) {
      ctx.addIssue({
        code: "custom",
        message: "business.priceBands must lie within eligibility.price.perMinute",
        path: ["business", "priceBands"],
      });
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function deepFreeze<T>(obj: T): DeepReadonly<T> {
  if (obj && typeof obj === "object") {
    Object.values(obj).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj as DeepReadonly<T>;
}

function load(): DeepReadonly<AppConfig> {
  const result = appConfigSchema.safeParse({
    catalog: catalogConfig,
    ranking: rankingConfig,
    eligibility: eligibilityConfig,
    business: businessConfig,
    providers: providerConfig,
    exploration: explorationConfig,
    analytics: analyticsConfig,
    user: userConfig,
    booking: bookingConfig,
    feed: feedConfig,
  });
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return deepFreeze(result.data);
}

/**
 * Validated, frozen application config. Import from "@/config" rather than
 * the individual *.config.ts files so invalid values fail fast at startup.
 */
export const config = load();
