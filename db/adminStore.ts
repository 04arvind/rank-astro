import type { AnyBulkWriteOperation, Collection, Filter } from "mongodb";
import { config } from "@/config";
import type { RejectedRecord } from "@/lib/astrologer";
import { validateAstrologer } from "@/lib/astrologer";
import type { ColumnMapping, SourceFormat } from "@/lib/admin";
import { DatabaseError, NotFoundError, ValidationError } from "@/lib/errors";
import type { AstrologerProfile, AvailabilityStatus } from "@/types/astrologer";
import { syncAstrologers, type SyncResult } from "./astrologerRepository";
import { databaseName, getDb } from "./client";
import { getCollections, stripId, type AstrologerDoc } from "./collections";

/*
 * Admin-side persistence: providers added from the dashboard, their import
 * history, and astrologers taken off the live list (hidden one by one, or
 * with their provider paused). Live astrologers stay in the `astrologers`
 * collection the ranking engine reads; hiding moves a document to
 * `astrologers_archived` and back, so no reader needs to know about it.
 */

export const ADMIN_COLLECTIONS = {
  providers: "admin_providers",
  imports: "admin_imports",
  archived: "astrologers_archived",
} as const;

export interface ProviderSource {
  kind: "link" | "upload";
  url?: string;
  fileName?: string;
  sheet?: string;
}

export interface AdminProviderDoc {
  _id: string;
  name: string;
  source?: ProviderSource;
  format?: SourceFormat;
  mapping?: ColumnMapping;
  mode?: ImportMode;
  defaultVerified?: boolean;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  lastImportAt?: number;
}

export type ImportMode = "merge" | "replace";

export interface ImportRecordDoc {
  _id: string;
  providerId: string;
  providerName: string;
  source: ProviderSource;
  format: SourceFormat;
  mode: ImportMode;
  rows: number;
  accepted: number;
  rejected: number;
  inserted: number;
  updated: number;
  removed: number;
  /** Re-imported astrologers that are hidden/paused stay hidden; counted here. */
  keptHidden: number;
  rejectedSample: RejectedRecord[];
  at: number;
  durationMs: number;
}

export type ArchiveReason = "hidden" | "provider_paused";
export type ArchivedDoc = AstrologerDoc & { archivedAt: number; archiveReason: ArchiveReason };

async function admin() {
  const db = await getDb();
  return {
    providers: db.collection<AdminProviderDoc>(ADMIN_COLLECTIONS.providers),
    imports: db.collection<ImportRecordDoc>(ADMIN_COLLECTIONS.imports),
    archived: db.collection<ArchivedDoc>(ADMIN_COLLECTIONS.archived),
  };
}

const dbError = (operation: string, collection: string, err: unknown) =>
  err instanceof DatabaseError || err instanceof ValidationError || err instanceof NotFoundError
    ? err
    : new DatabaseError(`Admin ${operation} failed`, { operation, collection }, { cause: err });

export async function ensureAdminIndexes(): Promise<void> {
  const c = await admin();
  await Promise.all([
    c.imports.createIndex({ at: -1 }),
    c.imports.createIndex({ providerId: 1, at: -1 }),
    c.archived.createIndex({ providerId: 1 }),
  ]);
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderSummary {
  id: string;
  name: string;
  /** Configured in config/provider.config.ts (has targets, shares, an adapter). */
  configured: boolean;
  /** Only configured + enabled providers pass ranking eligibility. */
  rankable: boolean;
  addedByAdmin: boolean;
  paused: boolean;
  live: number;
  hidden: number;
  online: number;
  avgPrice: number | null;
  source?: ProviderSource;
  lastImportAt?: number;
}

export async function getAdminProvider(id: string): Promise<AdminProviderDoc | null> {
  return (await admin()).providers.findOne({ _id: id });
}

export async function listProviderSummaries(): Promise<ProviderSummary[]> {
  try {
    const [{ astrologers }, c] = await Promise.all([getCollections(), admin()]);
    const [live, archived, registered] = await Promise.all([
      astrologers
        .aggregate<{ _id: string; n: number; online: number; avgPrice: number | null }>([
          {
            $group: {
              _id: "$providerId",
              n: { $sum: 1 },
              online: { $sum: { $cond: [{ $eq: ["$availability.status", "online"] }, 1, 0] } },
              avgPrice: { $avg: "$pricing.perMinute" },
            },
          },
        ])
        .toArray(),
      c.archived.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$providerId", n: { $sum: 1 } } }]).toArray(),
      c.providers.find().toArray(),
    ]);

    const liveBy = new Map(live.map((l) => [l._id, l]));
    const hiddenBy = new Map(archived.map((a) => [a._id, a.n]));
    const regBy = new Map(registered.map((r) => [r._id, r]));
    const ids = new Set([...config.providers.providers.map((p) => p.id), ...regBy.keys(), ...liveBy.keys(), ...hiddenBy.keys()]);

    return [...ids].map((id) => {
      const cfg = config.providers.providers.find((p) => p.id === id);
      const reg = regBy.get(id);
      const l = liveBy.get(id);
      return {
        id,
        name: reg?.name ?? cfg?.name ?? id,
        configured: Boolean(cfg),
        rankable: Boolean(cfg?.enabled),
        addedByAdmin: Boolean(reg) && !cfg,
        paused: reg?.paused ?? false,
        live: l?.n ?? 0,
        hidden: hiddenBy.get(id) ?? 0,
        online: l?.online ?? 0,
        avgPrice: l?.avgPrice ?? null,
        source: reg?.source,
        lastImportAt: reg?.lastImportAt,
      };
    });
  } catch (err) {
    throw dbError("listProviders", ADMIN_COLLECTIONS.providers, err);
  }
}

/** Saves the provider and how it was imported, so "Re-sync" can repeat it. */
export async function upsertAdminProvider(
  id: string,
  fields: Pick<AdminProviderDoc, "name" | "source" | "format" | "mapping" | "mode" | "defaultVerified" | "lastImportAt">,
): Promise<void> {
  const now = Date.now();
  await (await admin()).providers.updateOne(
    { _id: id },
    { $set: { ...fields, updatedAt: now }, $setOnInsert: { paused: false, createdAt: now } },
    { upsert: true },
  );
}

/** Takes every live astrologer of the provider off the list (reversible). */
export async function pauseProvider(providerId: string): Promise<number> {
  const moved = await moveToArchive({ providerId }, "provider_paused");
  await (await admin()).providers.updateOne(
    { _id: providerId },
    { $set: { paused: true, updatedAt: Date.now() }, $setOnInsert: { name: providerNameOf(providerId), createdAt: Date.now() } },
    { upsert: true },
  );
  return moved;
}

export async function resumeProvider(providerId: string): Promise<number> {
  const restored = await restoreFromArchive({ providerId, archiveReason: "provider_paused" });
  await (await admin()).providers.updateOne({ _id: providerId }, { $set: { paused: false, updatedAt: Date.now() } });
  return restored;
}

/** Removes the provider's astrologers (live and hidden) and, if admin-added, the provider itself. */
export async function deleteProvider(providerId: string): Promise<{ removed: number }> {
  try {
    const [{ astrologers }, c] = await Promise.all([getCollections(), admin()]);
    const [a, b] = await Promise.all([astrologers.deleteMany({ providerId }), c.archived.deleteMany({ providerId })]);
    await c.providers.deleteOne({ _id: providerId });
    return { removed: a.deletedCount + b.deletedCount };
  } catch (err) {
    throw dbError("deleteProvider", "astrologers", err);
  }
}

function providerNameOf(id: string): string {
  return config.providers.providers.find((p) => p.id === id)?.name ?? id;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportWriteResult extends SyncResult {
  keptHidden: number;
}

/**
 * Writes normalized astrologers for one provider. "merge" upserts only;
 * "replace" also removes the provider's astrologers missing from the sheet.
 * Astrologers an admin hid (or whose provider is paused) are updated in the
 * archive and stay hidden. A paused provider's new astrologers are archived too.
 */
export async function writeImport(providerId: string, list: readonly AstrologerProfile[], mode: ImportMode): Promise<ImportWriteResult> {
  try {
    const [{ astrologers }, c] = await Promise.all([getCollections(), admin()]);
    const paused = (await c.providers.findOne({ _id: providerId }, { projection: { paused: 1 } }))?.paused ?? false;
    const ids = list.map((a) => a.id);
    const archivedDocs = await c.archived.find({ _id: { $in: ids } }, { projection: { archiveReason: 1 } }).toArray();
    const archivedReason = new Map(archivedDocs.map((d) => [d._id, d.archiveReason]));

    const now = Date.now();
    const live = list.filter((a) => !paused && !archivedReason.has(a.id));
    const hidden = list.filter((a) => paused || archivedReason.has(a.id));

    let result: SyncResult;
    if (mode === "replace") {
      result = await syncAstrologers(live, [providerId]);
      await c.archived.deleteMany({ providerId, _id: { $nin: ids } });
    } else {
      const ops: AnyBulkWriteOperation<AstrologerDoc>[] = live.map((a) => ({
        replaceOne: { filter: { _id: a.id }, replacement: { ...a, syncedAt: now }, upsert: true },
      }));
      const w = ops.length ? await astrologers.bulkWrite(ops, { ordered: false }) : null;
      result = { upserted: w?.upsertedCount ?? 0, modified: w?.modifiedCount ?? 0, removed: 0 };
    }

    if (hidden.length) {
      await c.archived.bulkWrite(
        hidden.map((a) => ({
          replaceOne: {
            filter: { _id: a.id },
            replacement: { ...a, syncedAt: now, archivedAt: now, archiveReason: archivedReason.get(a.id) ?? "provider_paused" },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    return { ...result, keptHidden: hidden.length };
  } catch (err) {
    throw dbError("import", "astrologers", err);
  }
}

export async function recordImport(rec: Omit<ImportRecordDoc, "_id">): Promise<ImportRecordDoc> {
  const doc: ImportRecordDoc = { ...rec, _id: crypto.randomUUID(), rejectedSample: rec.rejectedSample.slice(0, 200) };
  await (await admin()).imports.insertOne(doc);
  return doc;
}

export async function listImports({ providerId, limit = 20 }: { providerId?: string; limit?: number } = {}): Promise<ImportRecordDoc[]> {
  try {
    const filter: Filter<ImportRecordDoc> = providerId ? { providerId } : {};
    return await (await admin()).imports.find(filter).sort({ at: -1 }).limit(limit).toArray();
  } catch (err) {
    throw dbError("listImports", ADMIN_COLLECTIONS.imports, err);
  }
}

// ---------------------------------------------------------------------------
// Astrologers
// ---------------------------------------------------------------------------

export interface AdminAstrologerRow {
  id: string;
  providerId: string;
  name: string;
  perMinute: number;
  rating: number | null;
  reviewCount: number;
  experienceYears: number | null;
  languages: string[];
  categories: string[];
  specializations: string[];
  status: AvailabilityStatus;
  verified: boolean;
  tier?: string;
  hidden: boolean;
  archiveReason?: ArchiveReason;
  missing: string[];
  unmapped: string[];
  importedAt: number;
}

export interface AstrologerQuery {
  providerId?: string;
  q?: string;
  view: "live" | "hidden";
  status?: AvailabilityStatus;
  page: number;
  pageSize: number;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toRow(doc: AstrologerDoc | ArchivedDoc, hidden: boolean): AdminAstrologerRow {
  return {
    id: doc._id,
    providerId: doc.providerId,
    name: doc.name,
    perMinute: doc.pricing.perMinute,
    rating: doc.rating,
    reviewCount: doc.reviewCount,
    experienceYears: doc.experienceYears,
    languages: doc.languages,
    categories: doc.categories,
    specializations: doc.specializations,
    status: doc.availability.status,
    verified: doc.verified,
    tier: doc.tier,
    hidden,
    archiveReason: "archiveReason" in doc ? doc.archiveReason : undefined,
    missing: doc.dataQuality?.missing ?? [],
    unmapped: doc.dataQuality?.unmapped ?? [],
    importedAt: doc.source?.importedAt ?? 0,
  };
}

export async function listAdminAstrologers(q: AstrologerQuery): Promise<{ items: AdminAstrologerRow[]; total: number }> {
  try {
    const filter: Filter<AstrologerDoc> = {};
    if (q.providerId) filter.providerId = q.providerId;
    if (q.status) filter["availability.status"] = q.status;
    if (q.q?.trim()) {
      const rx = new RegExp(escapeRegex(q.q.trim()), "i");
      filter.$or = [{ name: rx }, { _id: rx }];
    }
    const col: Collection<AstrologerDoc> =
      q.view === "hidden" ? ((await admin()).archived as unknown as Collection<AstrologerDoc>) : (await getCollections()).astrologers;
    const [docs, total] = await Promise.all([
      col.find(filter).sort({ name: 1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).toArray(),
      col.countDocuments(filter),
    ]);
    return { items: docs.map((d) => toRow(d, q.view === "hidden")), total };
  } catch (err) {
    throw dbError("listAstrologers", "astrologers", err);
  }
}

/** All live astrologers of a provider (or all), for CSV export. */
export async function exportAstrologers(providerId?: string): Promise<AdminAstrologerRow[]> {
  const { astrologers } = await getCollections();
  const docs = await astrologers.find(providerId ? { providerId } : {}).sort({ providerId: 1, name: 1 }).toArray();
  return docs.map((d) => toRow(d, false));
}

export interface AstrologerEdit {
  name?: string;
  perMinute?: number;
  status?: AvailabilityStatus;
  verified?: boolean;
  tier?: string | null;
  experienceYears?: number | null;
  rating?: number | null;
}

/** Applies an admin edit to a live or hidden astrologer; the result must still pass the common schema. */
export async function updateAstrologer(id: string, edit: AstrologerEdit): Promise<AdminAstrologerRow> {
  try {
    const [{ astrologers }, c] = await Promise.all([getCollections(), admin()]);
    const liveDoc = await astrologers.findOne({ _id: id });
    const doc = liveDoc ?? (await c.archived.findOne({ _id: id }));
    if (!doc) throw new NotFoundError("Astrologer", id);

    const { syncedAt, ...rest } = stripId(doc) as AstrologerProfile & { syncedAt: number; archivedAt?: number; archiveReason?: ArchiveReason };
    void syncedAt;
    const { archivedAt, archiveReason, ...profile } = rest;
    const next: AstrologerProfile = {
      ...profile,
      ...(edit.name !== undefined && { name: edit.name.trim() }),
      ...(edit.verified !== undefined && { verified: edit.verified }),
      ...(edit.experienceYears !== undefined && { experienceYears: edit.experienceYears }),
      ...(edit.rating !== undefined && { rating: edit.rating }),
      tier: edit.tier === null ? undefined : (edit.tier ?? profile.tier),
      pricing: { ...profile.pricing, ...(edit.perMinute !== undefined && { perMinute: edit.perMinute }) },
      availability: { ...profile.availability, ...(edit.status !== undefined && { status: edit.status }) },
    };
    if (next.tier === undefined) delete next.tier;

    const v = validateAstrologer(next);
    if (!v.ok) throw new ValidationError("Edit doesn't fit the astrologer schema", v.issues);

    const now = Date.now();
    if (liveDoc) {
      await astrologers.replaceOne({ _id: id }, { ...v.value, syncedAt: now });
      return toRow({ ...v.value, _id: id, syncedAt: now }, false);
    }
    const archived: ArchivedDoc = { ...v.value, _id: id, syncedAt: now, archivedAt: archivedAt ?? now, archiveReason: archiveReason ?? "hidden" };
    await c.archived.replaceOne({ _id: id }, archived);
    return toRow(archived, true);
  } catch (err) {
    throw dbError("updateAstrologer", "astrologers", err);
  }
}

async function moveToArchive(filter: Filter<AstrologerDoc>, reason: ArchiveReason): Promise<number> {
  try {
    const [{ astrologers }, c] = await Promise.all([getCollections(), admin()]);
    const docs = await astrologers.find(filter).toArray();
    if (!docs.length) return 0;
    const now = Date.now();
    await c.archived.bulkWrite(
      docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: { ...d, archivedAt: now, archiveReason: reason }, upsert: true } })),
      { ordered: false },
    );
    await astrologers.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
    return docs.length;
  } catch (err) {
    throw dbError("archive", ADMIN_COLLECTIONS.archived, err);
  }
}

async function restoreFromArchive(filter: Filter<ArchivedDoc>): Promise<number> {
  try {
    const [{ astrologers }, c] = await Promise.all([getCollections(), admin()]);
    const docs = await c.archived.find(filter).toArray();
    if (!docs.length) return 0;
    await astrologers.bulkWrite(
      docs.map((d) => {
        const { archivedAt, archiveReason, ...doc } = d;
        void archivedAt;
        void archiveReason;
        return { replaceOne: { filter: { _id: d._id }, replacement: doc, upsert: true } };
      }),
      { ordered: false },
    );
    await c.archived.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
    return docs.length;
  } catch (err) {
    throw dbError("restore", ADMIN_COLLECTIONS.archived, err);
  }
}

export const hideAstrologers = (ids: string[]) => moveToArchive({ _id: { $in: ids } }, "hidden");
export const unhideAstrologers = (ids: string[]) => restoreFromArchive({ _id: { $in: ids } });

export async function deleteAstrologers(ids: string[]): Promise<number> {
  try {
    const [{ astrologers }, c] = await Promise.all([getCollections(), admin()]);
    const [a, b] = await Promise.all([astrologers.deleteMany({ _id: { $in: ids } }), c.archived.deleteMany({ _id: { $in: ids } })]);
    return a.deletedCount + b.deletedCount;
  } catch (err) {
    throw dbError("deleteAstrologers", "astrologers", err);
  }
}

/**
 * After the built-in feed sync re-adds every feed astrologer, takes the
 * hidden/paused ones back off the live list so admin decisions survive.
 */
export async function reapplyHidden(): Promise<number> {
  const [{ astrologers }, c] = await Promise.all([getCollections(), admin()]);
  const ids = (await c.archived.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
  if (!ids.length) return 0;
  return (await astrologers.deleteMany({ _id: { $in: ids } })).deletedCount;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface DatabaseOverview {
  database: string;
  pingMs: number;
  live: number;
  hidden: number;
  providers: number;
  imports: number;
  lastImportAt: number | null;
}

export async function getDatabaseOverview(): Promise<DatabaseOverview> {
  try {
    const db = await getDb();
    const started = Date.now();
    await db.command({ ping: 1 });
    const pingMs = Date.now() - started;
    const [{ astrologers }, c] = await Promise.all([getCollections(), admin()]);
    const [live, hidden, providers, imports, last] = await Promise.all([
      astrologers.countDocuments(),
      c.archived.countDocuments(),
      astrologers.distinct("providerId"),
      c.imports.countDocuments(),
      c.imports.find({}, { projection: { at: 1 } }).sort({ at: -1 }).limit(1).next(),
    ]);
    return { database: databaseName(), pingMs, live, hidden, providers: providers.length, imports, lastImportAt: last?.at ?? null };
  } catch (err) {
    throw dbError("overview", "astrologers", err);
  }
}
