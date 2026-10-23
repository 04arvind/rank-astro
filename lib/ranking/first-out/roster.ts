import { config } from "@/config";
import { canTake, listEligibleAstrologers, type DurationMinutes } from "@/lib/consultation/offers";
import { listProviders } from "@/lib/providers";
import type { AstrologerProfile } from "@/types/astrologer";

/*
 * The First-Out roster: one "sheet" per enabled provider (config order,
 * i.e. the provider feeds in data/csv), each listing its astrologers in the
 * feed's row order. Round-robin positions index into these lists, so they
 * stay stable while the feed files don't change.
 */

export interface Sheet {
  providerId: string;
  astrologers: AstrologerProfile[];
}

/** Feed row number from `source.ref` ("row:12"); rows without one sort last. */
function rowOf(a: AstrologerProfile): number {
  const n = Number(/^row:(\d+)$/.exec(a.source.ref ?? "")?.[1]);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

const byRow = (x: AstrologerProfile, y: AstrologerProfile) => rowOf(x) - rowOf(y) || x.id.localeCompare(y.id);

/** Every enabled provider's sheet, including empty ones, so sheet positions never shift. */
export function buildSheets(astrologers: readonly AstrologerProfile[]): Sheet[] {
  return listProviders({ enabledOnly: true }).map((p) => ({
    providerId: p.id,
    astrologers: astrologers.filter((a) => a.providerId === p.id).sort(byRow),
  }));
}

/** What the user picked on the duration-card form, as sent with the booking (labels, e.g. "Numerology", "Hindi"). */
export interface FirstOutPreferences {
  topic?: string | null;
  language?: string | null;
}

/** Form subjects whose label isn't a catalog label or alias: "Kundli" is Vedic; "Family" matches anyone. */
const SUBJECT_TOPICS: Record<string, string | null> = { kundli: "vedic", family: null };

const catalogIndex = (options: readonly { id: string; label: string; aliases: readonly string[] }[]) => {
  const index = new Map<string, string>();
  for (const o of options) for (const key of [o.id, o.label, ...o.aliases]) index.set(key.trim().toLowerCase(), o.id);
  return index;
};

/** Catalog category/specialization id for a topic label; null = no topic filter. */
function topicId(topic: string | null | undefined): string | null {
  const key = topic?.trim().toLowerCase();
  if (!key) return null;
  if (key in SUBJECT_TOPICS) return SUBJECT_TOPICS[key];
  const { categories, specializations } = config.catalog;
  return catalogIndex([...categories, ...specializations]).get(key) ?? key;
}

/** Catalog language id for a language label; null ("Any" or not given) = no language filter. */
function languageId(language: string | null | undefined): string | null {
  const key = language?.trim().toLowerCase();
  if (!key || key === "any") return null;
  return catalogIndex(config.catalog.languages).get(key) ?? key;
}

/**
 * Narrows a First-Out pool to astrologers who match what the user picked:
 * the topic among their categories or specializations, and the language
 * among their languages. An unset (or "Any") preference doesn't filter.
 * Nobody matching means nobody is assigned — never someone off-topic.
 */
export function filterByPreferences(pool: readonly AstrologerProfile[], prefs: FirstOutPreferences | undefined): AstrologerProfile[] {
  const topic = topicId(prefs?.topic);
  const language = languageId(prefs?.language);
  return pool.filter(
    (a) => (!topic || a.categories.includes(topic) || a.specializations.includes(topic)) && (!language || a.languages.includes(language)),
  );
}

/**
 * Who can take a First-Out call of this length: eligible on the platform,
 * audio, minimum call time fits. Not narrowed to the card's cheapest price,
 * so every sheet takes its turn.
 */
export async function getFirstOutPool(minutes: DurationMinutes, now = Date.now()): Promise<AstrologerProfile[]> {
  const eligible = (await listEligibleAstrologers(now)).filter((a) => canTake(a, minutes));
  return buildSheets(eligible).flatMap((s) => s.astrologers);
}
