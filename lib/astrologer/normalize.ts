import { ConfigurationError } from "@/lib/errors";
import { getProviderAdapter } from "@/lib/providers";
import type { Astrologer, AstrologerProfile } from "@/types/astrologer";
import { validate, type ValidationIssue } from "@/lib/utils/validation";
import { validateAstrologer } from "./validation";

export interface RejectedRecord {
  providerId: string;
  ref: string;
  stage: "raw" | "profile" | "duplicate";
  issues: ValidationIssue[];
}

export interface NormalizationResult {
  astrologers: AstrologerProfile[];
  rejected: RejectedRecord[];
}

export interface NormalizeOptions {
  importedAt?: number;
  /** Builds a record reference for error reports; defaults to the row index. */
  refOf?: (record: unknown, index: number) => string;
}

/**
 * Converts one provider's raw records into the common astrologer model:
 * raw-schema check → provider adapter → common-model validation → de-dup.
 * Bad records are reported, never thrown, so one row can't sink a feed.
 */
export function normalizeProviderFeed(
  providerId: string,
  records: readonly unknown[],
  { importedAt = Date.now(), refOf = (_r, i) => `row:${i + 1}` }: NormalizeOptions = {},
): NormalizationResult {
  const adapter = getProviderAdapter(providerId);
  if (!adapter) throw new ConfigurationError("No adapter registered for provider", { providerId });

  const astrologers: AstrologerProfile[] = [];
  const rejected: RejectedRecord[] = [];
  const seen = new Set<string>();

  records.forEach((record, index) => {
    const ref = refOf(record, index);
    const parsed = validate(adapter.rawSchema, record);
    if (!parsed.ok) {
      rejected.push({ providerId, ref, stage: "raw", issues: parsed.issues });
      return;
    }

    const draft = adapter.toProfile(parsed.value);
    const result = validateAstrologer({
      ...draft,
      id: `${providerId}:${draft.sourceId}`,
      providerId,
      source: { importedAt, ref },
    });
    if (!result.ok) {
      rejected.push({ providerId, ref, stage: "profile", issues: result.issues });
      return;
    }

    if (seen.has(result.value.id)) {
      rejected.push({
        providerId,
        ref,
        stage: "duplicate",
        issues: [{ path: "id", message: `duplicate of ${result.value.id}` }],
      });
      return;
    }
    seen.add(result.value.id);
    astrologers.push(result.value);
  });

  return { astrologers, rejected };
}

/** Normalizes several provider feeds at once. */
export function normalizeFeeds(
  feeds: Readonly<Record<string, readonly unknown[]>>,
  options?: NormalizeOptions,
): NormalizationResult {
  const out: NormalizationResult = { astrologers: [], rejected: [] };
  for (const [providerId, records] of Object.entries(feeds)) {
    const r = normalizeProviderFeed(providerId, records, options);
    out.astrologers.push(...r.astrologers);
    out.rejected.push(...r.rejected);
  }
  return out;
}

/** Public API shape of a normalized astrologer. */
export function toPublicAstrologer(a: AstrologerProfile): Astrologer {
  return {
    id: a.id,
    providerId: a.providerId,
    name: a.name,
    tagline: a.tagline,
    languages: a.languages,
    categories: a.categories,
    specializations: a.specializations,
    consultationModes: a.consultationModes,
    experienceYears: a.experienceYears,
    rating: a.rating,
    reviewCount: a.reviewCount,
    pricePerMinute: a.pricing.perMinute,
    isOnline: a.availability.status === "online",
    avatarUrl: a.avatarUrl,
  };
}
