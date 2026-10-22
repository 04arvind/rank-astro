import { z } from "zod";
import { ProviderError } from "@/lib/errors";
import { toBoolean } from "@/lib/utils/parse";
import { cell, epochMs, list, mapToCatalog, money, slugify, years } from "./parsers";
import type { AvailabilityStatus } from "@/types/astrologer";
import { missingFields, type AvailabilityUpdate, type ProviderAdapter } from "./types";

/**
 * Provider C — astrologer sheet (data/csv/providerC.xlsx; currently a text export). Exported as
 * tab-separated rows each wrapped in one quoted CSV cell; list cells look
 * like `"Hindi","English"`. Contact and gender columns are intentionally
 * not read. Call stats (total_calls, …) are the provider's own counts and
 * are not part of the common model — platform metrics come from lib/analytics.
 */
const raw = z.object({
  provider_astrologer_id: cell.pipe(z.string()),
  name: cell.pipe(z.string()),
  languages: cell,
  categories: cell,
  experience_years: cell,
  rating: cell,
  review_count: cell,
  price_per_minute: cell,
  currency: cell,
  status: cell,
  available_for_call: cell,
});

type Raw = z.output<typeof raw>;

// ASSUMED availability endpoint: GET {PROVIDER_C_API_URL}/availability?ids=a,b
const availabilityResponse = z.object({
  data: z.array(
    z.object({
      astrologer_id: z.union([z.string(), z.number()]).transform(String),
      status: z.enum(["online", "busy", "offline"]),
      last_active_at: z.union([z.string(), z.number()]).optional(),
    }),
  ),
});

async function fetchAvailability(
  sourceIds: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, AvailabilityUpdate>> {
  const base = process.env.PROVIDER_C_API_URL;
  if (!base || sourceIds.length === 0) return new Map();

  const url = new URL("availability", base.endsWith("/") ? base : `${base}/`);
  url.searchParams.set("ids", sourceIds.join(","));
  const res = await fetch(url, {
    signal,
    headers: { authorization: `Bearer ${process.env.PROVIDER_C_API_KEY ?? ""}` },
    cache: "no-store",
  });
  const context = { providerId: "providerC", operation: "availability", upstreamStatus: res.status };
  if (!res.ok) throw new ProviderError("Availability request failed", context);

  const body = availabilityResponse.safeParse(await res.json().catch(() => undefined));
  if (!body.success) throw new ProviderError("Availability response had an unexpected shape", context, { cause: body.error });
  return new Map(
    body.data.data.map((d) => [d.astrologer_id, { status: d.status, lastActiveAt: epochMs(d.last_active_at) ?? null }]),
  );
}

const STATUSES = new Set(["online", "busy", "offline"]);

/** `"Hindi","English"` → ["Hindi", "English"]. */
const quotedList = (v: unknown) => list(v)?.map((x) => x.replace(/^"+|"+$/g, "").trim()).filter(Boolean);

export const providerC: ProviderAdapter<Raw> = {
  id: "providerC",
  feed: { format: "csv", delimiter: "	", wrappedRows: true, defaultPath: "data/csv/providerC.xlsx" },
  rawSchema: raw,
  fetchAvailability,

  toProfile(r) {
    const rawLanguages = quotedList(r.languages);
    const rawCategories = quotedList(r.categories);
    const languages = mapToCatalog("languages", rawLanguages ?? []);
    const categories = mapToCatalog("categories", rawCategories ?? []);
    const experienceYears = years(r.experience_years);
    const rating = money(r.rating);

    const statusText = r.status?.toLowerCase();
    let status: AvailabilityStatus = statusText && STATUSES.has(statusText) ? (statusText as AvailabilityStatus) : "unknown";
    // "online" but flagged not available for calls can't take a call right now.
    if (status === "online" && toBoolean(r.available_for_call) === false) status = "busy";

    const currency = r.currency?.toUpperCase();
    const unmapped = [...languages.unmapped, ...categories.unmapped];
    if (currency && currency !== "INR") unmapped.push(`currency:${currency}`);

    return {
      sourceId: slugify(r.provider_astrologer_id),
      externalId: r.provider_astrologer_id,
      name: r.name.trim(),
      languages: languages.ids,
      categories: categories.ids,
      specializations: [],
      consultationModes: ["audio"],
      experienceYears: experienceYears ?? null,
      rating: rating ?? null,
      reviewCount: money(r.review_count) ?? 0,
      pricing: {
        perMinute: money(r.price_per_minute) ?? 0,
        minCallMinutes: null,
        packages: [],
        payoutPerMinute: null,
      },
      availability: { status, lastActiveAt: null },
      // Assumption: the sheet lists active, rated astrologers already live on the provider.
      verified: true,
      onboardedAt: null,
      dataQuality: {
        missing: missingFields({
          languages: rawLanguages,
          categories: rawCategories,
          specializations: undefined,
          experienceYears,
          rating,
          avatarUrl: undefined,
          about: undefined,
          availability: status === "unknown" ? undefined : status,
          onboardedAt: undefined,
          payout: undefined,
        }),
        unmapped,
      },
    };
  },
};
