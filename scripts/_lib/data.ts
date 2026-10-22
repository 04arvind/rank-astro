import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAnalyticsStore, recordCall, recordClicks, recordImpressions, recordRating } from "@/lib/analytics";
import {
  InMemoryAstrologerRepository,
  normalizeFeeds,
  NORMALIZED_SNAPSHOT,
  setAstrologerRepository,
  SnapshotAstrologerRepository,
  type NormalizationResult,
} from "@/lib/astrologer";
import { isAppError, toPublicError } from "@/lib/errors";
import { listProviders, loadProviderRecords } from "@/lib/providers";
import type { AnalyticsEvent, AnalyticsEventType } from "@/types/analytics";
import type { AstrologerProfile } from "@/types/astrologer";
import { ROOT } from "./cli";

export interface FeedLoad {
  feeds: Record<string, unknown[]>;
  /** Providers whose feed could not be loaded, with a readable reason. */
  failures: { providerId: string; code: string; message: string }[];
}

/**
 * Loads raw records for the chosen providers (all configured by default).
 * `files` overrides a provider's default feed path: { providerA: "x.csv" }.
 */
export async function loadFeeds(providerIds?: string[], files: Record<string, string> = {}): Promise<FeedLoad> {
  const ids = providerIds?.length ? providerIds : listProviders().map((p) => p.id);
  const out: FeedLoad = { feeds: {}, failures: [] };
  for (const id of ids) {
    try {
      out.feeds[id] = await loadProviderRecords(id, files[id]);
    } catch (err) {
      if (!isAppError(err)) throw err;
      const cause = err.cause instanceof Error ? ` (${err.cause.message.split("\n")[0]})` : "";
      out.failures.push({ providerId: id, code: err.code, message: `${err.message}${cause}` });
    }
  }
  return out;
}

/** "providerA=path.csv,providerB=x.xlsx" → { providerA: "path.csv", … } */
export function parseFileOverrides(v: string | undefined): Record<string, string> {
  if (!v) return {};
  return Object.fromEntries(
    v.split(",").map((pair) => {
      const [id, file] = pair.split("=").map((s) => s.trim());
      if (!id || !file) throw new Error(`Bad --files entry "${pair}" (expected providerId=path)`);
      return [id, file];
    }),
  );
}

/**
 * Astrologers for simulations/reports: the normalized snapshot by default,
 * or freshly normalized feeds. Installs them as the active repository.
 */
export async function loadAstrologers(fromFeeds: boolean): Promise<{ astrologers: AstrologerProfile[]; source: string; normalization?: NormalizationResult }> {
  let astrologers: AstrologerProfile[];
  let source: string;
  let normalization: NormalizationResult | undefined;

  if (fromFeeds) {
    const { feeds, failures } = await loadFeeds();
    for (const f of failures) console.warn(`  ⚠ ${f.providerId}: ${f.message}`);
    normalization = normalizeFeeds(feeds);
    astrologers = normalization.astrologers;
    source = `provider feeds (${Object.keys(feeds).join(", ")})`;
  } else {
    astrologers = await new SnapshotAstrologerRepository().list();
    source = path.relative(ROOT, NORMALIZED_SNAPSHOT);
    if (astrologers.length === 0) {
      throw new Error(`No astrologers in ${source}. Run \`npm run data:normalize\` first, or pass --from-feeds.`);
    }
  }
  setAstrologerRepository(new InMemoryAstrologerRepository(astrologers));
  return { astrologers, source, normalization };
}

// ---------------------------------------------------------------------------
// Analytics event files
// ---------------------------------------------------------------------------

const TYPES: AnalyticsEventType[] = ["impression", "click", "call", "rating"];
const ALL_TIME = { from: 0, to: Number.MAX_SAFE_INTEGER };

/** Dumps every event in the (in-memory) analytics store. */
export async function exportEvents(): Promise<AnalyticsEvent[]> {
  const store = getAnalyticsStore();
  const lists = await Promise.all(TYPES.map((type) => store.query({ type, range: ALL_TIME })));
  return lists.flat().sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Loads an events file into the analytics store through the normal record*
 * functions, so every event is re-validated. Returns counts per type.
 */
export async function importEvents(file: string): Promise<Record<string, number>> {
  const parsed = JSON.parse(await readFile(path.resolve(ROOT, file), "utf8")) as { events?: unknown };
  if (!Array.isArray(parsed.events)) throw new Error(`${file} has no "events" array`);

  const counts: Record<string, number> = {};
  const rejected: string[] = [];
  for (const [i, raw] of parsed.events.entries()) {
    const e = raw as { type?: string };
    try {
      // One at a time so a single bad event doesn't discard a whole batch.
      if (e.type === "impression") await recordImpressions([e as Parameters<typeof recordImpressions>[0][number]]);
      else if (e.type === "click") await recordClicks([e as Parameters<typeof recordClicks>[0][number]]);
      else if (e.type === "call") await recordCall(e as Parameters<typeof recordCall>[0]);
      else if (e.type === "rating") await recordRating(e as Parameters<typeof recordRating>[0]);
      else throw new Error(`unknown type "${e.type}"`);
      counts[e.type] = (counts[e.type] ?? 0) + 1;
    } catch (err) {
      rejected.push(`#${i}: ${isAppError(err) ? JSON.stringify(toPublicError(err).details ?? err.message) : (err as Error).message}`);
    }
  }
  if (rejected.length) {
    console.warn(`  ⚠ ${rejected.length} events rejected, e.g. ${rejected.slice(0, 3).join(" | ")}`);
  }
  return counts;
}
