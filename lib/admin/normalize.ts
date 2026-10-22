import { createHash } from "node:crypto";
import { validateAstrologer, type RejectedRecord } from "@/lib/astrologer";
import { consultationModes, epochMs, httpUrl, list, mapToCatalog, money, slugify, text, urlSlug, years } from "@/lib/providers/parsers";
import { missingFields } from "@/lib/providers/types";
import { toBoolean } from "@/lib/utils/parse";
import type { AstrologerProfile, AvailabilityStatus, ConsultationMode, PricePackage } from "@/types/astrologer";
import { packageMinutes, type ColumnMapping, type ImportField } from "./fields";
import type { Row } from "./tables";

/*
 * Rows from an admin-uploaded sheet → the common AstrologerProfile model,
 * validated by the same schema every provider feed goes through.
 */

export interface ImportOptions {
  providerId: string;
  /** Used when the sheet has no verified column. */
  defaultVerified: boolean;
  importedAt?: number;
}

export interface NormalizedImport {
  astrologers: AstrologerProfile[];
  rejected: RejectedRecord[];
}

/** Provider name → id usable in astrologer ids (`^[a-zA-Z0-9]+$`). */
export function providerIdFromName(name: string): string {
  const id = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  return id || `provider${createHash("sha1").update(name).digest("hex").slice(0, 8)}`;
}

/** `"Hindi","English"` → ["Hindi", "English"]. */
const items = (v: unknown) =>
  list(v)
    ?.map((x) => x.replace(/^"+|"+$/g, "").trim())
    .filter(Boolean);

const STATUS: Record<string, AvailabilityStatus> = {
  online: "online", available: "online", active: "online", live: "online", yes: "online", true: "online",
  busy: "busy", "on call": "busy", oncall: "busy", engaged: "busy",
  offline: "offline", inactive: "offline", away: "offline", unavailable: "offline", no: "offline", false: "offline",
};

const VERIFIED = /^(verified|approved|done|meet done|yes|y|true|1|kyc done|complete(d)?)$/i;

/** Excel serial dates (e.g. 45123) and date strings → epoch ms. */
function joinedAt(v: unknown): number | undefined {
  const s = text(v);
  if (s === undefined) return undefined;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) return Math.round((serial - 25569) * 86_400_000);
  }
  const t = epochMs(s);
  return t !== undefined && t >= 0 ? Math.round(t) : undefined;
}

const short = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);

/** Values of every column mapped to `field`, in sheet order. */
function columns(row: Row, mapping: ColumnMapping, field: ImportField): { header: string; value: string | undefined }[] {
  return Object.entries(mapping)
    .filter(([, f]) => f === field)
    .map(([header]) => ({ header, value: text(row[header]) }));
}

function toDraft(row: Row, mapping: ColumnMapping, opts: ImportOptions) {
  const one = (f: ImportField) => columns(row, mapping, f).find((c) => c.value !== undefined)?.value;
  const many = (f: ImportField) => {
    const all = columns(row, mapping, f).flatMap((c) => items(c.value) ?? []);
    return columns(row, mapping, f).some((c) => c.value !== undefined) ? all : undefined;
  };

  const name = one("name") ?? "";
  const externalId = one("externalId");
  const profileUrl = httpUrl(one("profileUrl"));
  const sourceId = (externalId && slugify(externalId)) || urlSlug(profileUrl) || slugify(name) || (name ? `a-${short(name)}` : "");

  const rawLanguages = many("languages");
  const rawCategories = many("categories");
  const rawSpecializations = many("specializations");
  const rawExpertise = many("expertise");
  const languages = mapToCatalog("languages", rawLanguages ?? []);
  const categories = mapToCatalog("categories", rawCategories ?? []);
  const specializations = mapToCatalog("specializations", rawSpecializations ?? []);
  // Expertise feeds both lists; a value is only "unmapped" if neither catalog knows it.
  const expCategories = mapToCatalog("categories", rawExpertise ?? []);
  const expSpecializations = mapToCatalog("specializations", rawExpertise ?? []);
  const expUnmapped = (rawExpertise ?? []).filter(
    (v) => expCategories.unmapped.includes(`categories:${v}`) && expSpecializations.unmapped.includes(`specializations:${v}`),
  );
  const unmapped = [...languages.unmapped, ...categories.unmapped, ...specializations.unmapped, ...expUnmapped.map((v) => `expertise:${v}`)];
  const categoryIds = [...new Set([...categories.ids, ...expCategories.ids])];
  const specializationIds = [...new Set([...specializations.ids, ...expSpecializations.ids])];

  const rawModes = many("consultationModes");
  const modes: ConsultationMode[] = rawModes ? consultationModes(rawModes) : ["audio"];

  const experience = years(one("experienceYears"));
  const experienceYears = experience !== undefined && experience <= 80 ? experience : undefined;
  if (experience !== undefined && experienceYears === undefined) unmapped.push(`experienceYears:${experience}`);

  const ratingRaw = money(one("rating"));
  const rating = ratingRaw !== undefined && ratingRaw <= 5 ? ratingRaw : undefined;
  if (ratingRaw !== undefined && rating === undefined) unmapped.push(`rating:${ratingRaw}`);

  const packages: PricePackage[] = [];
  for (const c of columns(row, mapping, "package")) {
    const minutes = packageMinutes(c.header);
    const price = money(c.value);
    if (minutes && price !== undefined) packages.push({ minutes, price });
  }

  const statusText = one("status")?.toLowerCase();
  const statusColumn = Object.values(mapping).includes("status");
  let status: AvailabilityStatus = (statusText && STATUS[statusText]) || "unknown";
  if (status === "online" && toBoolean(one("availableForCall")) === false) status = "busy";

  const verifiedText = one("verified");
  const verified = Object.values(mapping).includes("verified") ? Boolean(verifiedText && VERIFIED.test(verifiedText)) : opts.defaultVerified;

  const currency = one("currency")?.toUpperCase();
  if (currency && currency !== "INR" && currency !== "RS" && currency !== "₹") unmapped.push(`currency:${currency}`);

  const payout = money(one("payoutPerMinute"));
  const onboardedAt = joinedAt(one("onboardedAt"));
  const avatarUrl = httpUrl(one("avatarUrl"));
  const about = one("about")?.slice(0, 5000);
  const minCall = money(one("minCallMinutes"));

  return {
    sourceId,
    externalId: externalId && externalId.length <= 128 ? externalId : undefined,
    name: name.slice(0, 120),
    tagline: one("tagline")?.slice(0, 300),
    about,
    avatarUrl,
    profileUrl,
    languages: languages.ids,
    categories: categoryIds,
    specializations: specializationIds,
    consultationModes: modes,
    experienceYears: experienceYears ?? null,
    rating: rating ?? null,
    reviewCount: Math.max(0, Math.trunc(money(one("reviewCount")) ?? 0)),
    pricing: {
      // No per-minute column: the cheapest package's per-minute rate.
      perMinute: money(one("perMinute")) ?? (packages.length ? Math.min(...packages.map((p) => p.price / p.minutes)) : 0),
      minCallMinutes: minCall && minCall > 0 ? minCall : null,
      packages,
      payoutPerMinute: payout ?? null,
    },
    availability: { status, lastActiveAt: null },
    tier: one("tier")?.slice(0, 20),
    verified,
    onboardedAt: onboardedAt ?? null,
    dataQuality: {
      missing: missingFields({
        languages: rawLanguages,
        categories: rawCategories ?? rawExpertise,
        specializations: rawSpecializations ?? rawExpertise,
        experienceYears,
        rating,
        avatarUrl,
        about,
        availability: statusColumn && status !== "unknown" ? status : undefined,
        consultationModes: rawModes,
        onboardedAt,
        payout,
      }),
      unmapped,
    },
  };
}

/**
 * Normalizes every row; bad rows are reported, never thrown, so one row
 * can't sink the import. Duplicate ids within the sheet keep the first row.
 */
export function normalizeRows(rows: readonly Row[], mapping: ColumnMapping, opts: ImportOptions): NormalizedImport {
  const importedAt = opts.importedAt ?? Date.now();
  const astrologers: AstrologerProfile[] = [];
  const rejected: RejectedRecord[] = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    const ref = `row:${index + 2}`; // spreadsheet row number (header is row 1)
    const draft = toDraft(row, mapping, opts);
    const result = validateAstrologer({
      ...draft,
      id: `${opts.providerId}:${draft.sourceId}`,
      providerId: opts.providerId,
      source: { importedAt, ref },
    });
    if (!result.ok) {
      rejected.push({ providerId: opts.providerId, ref: `${ref}${draft.name ? ` (${draft.name})` : ""}`, stage: "profile", issues: result.issues });
      return;
    }
    if (seen.has(result.value.id)) {
      rejected.push({ providerId: opts.providerId, ref: `${ref} (${draft.name})`, stage: "duplicate", issues: [{ path: "id", message: `duplicate of ${result.value.id}` }] });
      return;
    }
    seen.add(result.value.id);
    astrologers.push(result.value);
  });

  return { astrologers, rejected };
}
