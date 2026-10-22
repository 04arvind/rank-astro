import { z } from "zod";
import { config } from "@/config";
import { lastPathSegment, slugify, toEpochMs, toHttpUrl, toList, toNumber } from "@/lib/utils/parse";
import type { ConsultationMode } from "@/types/astrologer";

/*
 * Provider-feed parsing conventions (placeholder cells, bilingual labels,
 * catalog aliases) layered on the generic parsers in lib/utils/parse.
 * Each returns undefined for "not supplied" so adapters can record missing fields.
 */

/** Placeholder values providers use for "not filled in yet". */
const PLACEHOLDERS = new Set(["", "-", "na", "n/a", "pending", "tbd", "null", "none"]);

/** A spreadsheet/API cell: trimmed string, or undefined when blank/placeholder. */
export const cell = z.preprocess((v) => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return PLACEHOLDERS.has(s.toLowerCase()) ? undefined : s;
}, z.string().optional());

export function text(v: unknown): string | undefined {
  return cell.parse(v);
}

/** "Hindi | हिंदी" → "Hindi" (keeps the English half of bilingual labels). */
export function englishPart(v: string): string {
  return v.split("|")[0].trim();
}

/** Comma/semicolon/slash separated list → trimmed, non-empty items. */
export function list(v: unknown): string[] | undefined {
  return toList(text(v), /[,;/]/);
}

/** First number in the English half: "₹1,500" → 1500, "30 Minutes | 30 मिनट" → 30. */
export function firstNumber(v: unknown): number | undefined {
  const s = text(v);
  return s === undefined ? undefined : toNumber(englishPart(s));
}

/** "₹1,500", "100/min", "2100/-", 250 → number. */
export const money = firstNumber;

/**
 * "10+ years" → 10, "3-5 years" → 3, "8" → 8.
 * Ranges resolve to their lower bound so experience is never overstated.
 */
export const years = firstNumber;

/** "30 Minutes" → 30. */
export const minutes = firstNumber;

export const epochMs = (v: unknown) => toEpochMs(typeof v === "number" ? v : text(v));
export const httpUrl = (v: unknown) => toHttpUrl(text(v));
export { slugify };

/** Slug from the last URL segment, e.g. ".../astrologer/vijay-sharma" → "vijay-sharma". */
export function urlSlug(v: unknown): string | undefined {
  const seg = lastPathSegment(text(v));
  return seg ? slugify(seg) || undefined : undefined;
}

// ---------------------------------------------------------------------------
// Catalog mapping
// ---------------------------------------------------------------------------

type CatalogKind = "categories" | "specializations" | "languages";

const lookup = new Map<CatalogKind, Map<string, string>>();

function catalogIndex(kind: CatalogKind): Map<string, string> {
  let index = lookup.get(kind);
  if (!index) {
    index = new Map();
    for (const o of config.catalog[kind]) {
      for (const key of [o.id, o.label, ...o.aliases]) index.set(key.toLowerCase(), o.id);
    }
    lookup.set(kind, index);
  }
  return index;
}

export interface MappedList {
  ids: string[];
  unmapped: string[];
}

/**
 * Maps raw provider labels onto catalog ids. Tries the full value, then each
 * half of a bilingual "English | हिंदी" label.
 */
export function mapToCatalog(kind: CatalogKind, values: readonly string[]): MappedList {
  const index = catalogIndex(kind);
  const ids = new Set<string>();
  const unmapped: string[] = [];
  for (const raw of values) {
    const candidates = [raw, ...raw.split("|")].map((s) => s.trim().toLowerCase()).filter(Boolean);
    const id = candidates.map((c) => index.get(c)).find(Boolean);
    if (id) ids.add(id);
    else unmapped.push(`${kind}:${raw}`);
  }
  return { ids: [...ids], unmapped };
}

const MODE_ALIASES: Record<string, ConsultationMode> = {
  audio: "audio",
  call: "audio",
  voice: "audio",
  phone: "audio",
  video: "video",
  chat: "chat",
  text: "chat",
};

export function consultationModes(values: readonly string[]): ConsultationMode[] {
  const modes = new Set<ConsultationMode>();
  for (const v of values) {
    const mode = MODE_ALIASES[englishPart(v).toLowerCase()];
    if (mode) modes.add(mode);
  }
  return [...modes];
}
