import { config } from "@/config";
import {
  ensureAdminIndexes,
  listProviderSummaries,
  recordImport,
  upsertAdminProvider,
  writeImport,
  type ImportMode,
  type ImportRecordDoc,
  type ProviderSource,
} from "@/db/adminStore";
import {
  detectMapping,
  downloadSource,
  isContactHeader,
  isImportField,
  normalizeRows,
  parseTable,
  providerIdFromName,
  type ColumnMapping,
  type NormalizedImport,
  type ParsedTable,
} from "@/lib/admin";
import { ValidationError } from "@/lib/errors";
import type { AstrologerProfile } from "@/types/astrologer";

/*
 * The "Add astrologers" flow shared by preview, import and re-sync:
 * fetch/parse the source → map columns → normalize → (import) write to MongoDB.
 */

export interface ImportInput {
  providerName: string;
  source: ProviderSource;
  /** Uploaded file bytes (source.kind === "upload"). */
  file?: Buffer;
  /** Admin overrides; auto-detected when absent. */
  mapping?: ColumnMapping;
  mode: ImportMode;
  defaultVerified: boolean;
}

export interface ResolvedProvider {
  id: string;
  name: string;
  existing: boolean;
  configured: boolean;
  rankable: boolean;
}

/** Matches the typed name against configured and admin-added providers (by name or id), else mints a new id. */
export async function resolveProvider(providerName: string): Promise<ResolvedProvider> {
  const name = providerName.trim();
  if (name.length < 2) throw new ValidationError("Enter the provider name", [{ path: "providerName", message: "Provider name is required" }]);
  const key = name.toLowerCase();
  const known = await listProviderSummaries();
  const hit = known.find((p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key) ?? known.find((p) => p.id === providerIdFromName(name));
  if (hit) return { id: hit.id, name: hit.name, existing: true, configured: hit.configured, rankable: hit.rankable };
  return { id: providerIdFromName(name), name, existing: false, configured: false, rankable: false };
}

async function readSource(input: ImportInput): Promise<ParsedTable & { fileName?: string }> {
  if (input.source.kind === "upload") {
    if (!input.file) throw new ValidationError("Choose a file to upload", [{ path: "file", message: "File is required" }]);
    return { ...(await parseTable(input.file, { hint: input.source.fileName, sheet: input.source.sheet })), fileName: input.source.fileName };
  }
  if (!input.source.url) throw new ValidationError("Paste the astrologer list link", [{ path: "url", message: "Link is required" }]);
  const dl = await downloadSource(input.source.url);
  return { ...(await parseTable(dl.buffer, { hint: `${dl.contentType} ${dl.fileName ?? ""}`, sheet: input.source.sheet })), fileName: dl.fileName };
}

/** Keeps admin overrides for headers that still exist; detects the rest. Contact columns are always ignored. */
function finalMapping(headers: string[], override?: ColumnMapping): ColumnMapping {
  const detected = detectMapping(headers);
  const out: ColumnMapping = {};
  for (const h of headers) {
    const o = override?.[h];
    out[h] = isContactHeader(h) ? "ignore" : o === "ignore" || isImportField(o) ? o : detected[h];
  }
  return out;
}

export interface Prepared {
  provider: ResolvedProvider;
  table: ParsedTable & { fileName?: string };
  mapping: ColumnMapping;
  result: NormalizedImport;
}

export async function prepareImport(input: ImportInput): Promise<Prepared> {
  const provider = await resolveProvider(input.providerName);
  const table = await readSource(input);
  const mapping = finalMapping(table.headers, input.mapping);
  const result = normalizeRows(table.rows, mapping, { providerId: provider.id, defaultVerified: input.defaultVerified });
  return { provider, table, mapping, result };
}

const catalogLabel = (kind: "languages" | "categories" | "specializations", id: string) =>
  config.catalog[kind].find((o) => o.id === id)?.label ?? id;

function sampleOf(a: AstrologerProfile) {
  return {
    id: a.id,
    name: a.name,
    perMinute: a.pricing.perMinute,
    languages: a.languages.map((l) => catalogLabel("languages", l)),
    expertise: [...a.categories.map((c) => catalogLabel("categories", c)), ...a.specializations.map((s) => catalogLabel("specializations", s))],
    experienceYears: a.experienceYears,
    rating: a.rating,
    status: a.availability.status,
    verified: a.verified,
  };
}

/** What the admin sees before committing. */
export function previewOf(p: Prepared) {
  const unmapped = new Map<string, number>();
  for (const a of p.result.astrologers) for (const u of a.dataQuality.unmapped) unmapped.set(u, (unmapped.get(u) ?? 0) + 1);
  return {
    provider: p.provider,
    format: p.table.format,
    fileName: p.table.fileName,
    headers: p.table.headers,
    mapping: p.mapping,
    contactColumns: p.table.headers.filter(isContactHeader),
    rows: p.table.rows.length,
    accepted: p.result.astrologers.length,
    rejected: p.result.rejected.length,
    rejectedSample: p.result.rejected.slice(0, 25),
    sample: p.result.astrologers.slice(0, 8).map(sampleOf),
    unmapped: [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 20),
  };
}

let indexed = false;

export async function runImport(input: ImportInput): Promise<{ preview: ReturnType<typeof previewOf>; record: ImportRecordDoc }> {
  const started = Date.now();
  const prepared = await prepareImport(input);
  const { provider, table, mapping, result } = prepared;
  if (result.astrologers.length === 0) {
    throw new ValidationError(
      "No row could be imported — check the column mapping (Name and Price per minute are required)",
      result.rejected.slice(0, 10).flatMap((r) => r.issues.map((i) => ({ path: `${r.ref} ${i.path}`, message: i.message }))),
    );
  }

  if (!indexed) {
    await ensureAdminIndexes();
    indexed = true;
  }
  const written = await writeImport(provider.id, result.astrologers, input.mode);
  const at = Date.now();
  const source: ProviderSource = { ...input.source, fileName: table.fileName ?? input.source.fileName };
  await upsertAdminProvider(provider.id, {
    name: provider.name,
    source,
    format: table.format,
    mapping,
    mode: input.mode,
    defaultVerified: input.defaultVerified,
    lastImportAt: at,
  });
  const record = await recordImport({
    providerId: provider.id,
    providerName: provider.name,
    source,
    format: table.format,
    mode: input.mode,
    rows: table.rows.length,
    accepted: result.astrologers.length,
    rejected: result.rejected.length,
    inserted: written.upserted,
    updated: written.modified,
    removed: written.removed,
    keptHidden: written.keptHidden,
    rejectedSample: result.rejected,
    at,
    durationMs: at - started,
  });
  return { preview: previewOf(prepared), record };
}
