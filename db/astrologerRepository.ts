import type { AnyBulkWriteOperation } from "mongodb";
import {
  FeedAstrologerRepository,
  InMemoryAstrologerRepository,
  validateAstrologer,
  type AstrologerRepository,
} from "@/lib/astrologer";
import { DatabaseError, InvalidAstrologerDataError, logError } from "@/lib/errors";
import type { AstrologerProfile } from "@/types/astrologer";
import { getCollections, stripId, type AstrologerDoc } from "./collections";

/**
 * Astrologers from the `astrologers` collection. The whole set is cached
 * for `cacheMs` (ranking lists every astrologer on each request). Rows are
 * re-validated on read so a hand-edited document can't poison ranking.
 * If the collection is empty, or MongoDB fails with nothing cached, the
 * fallback (the CSV feeds by default) serves instead; a failure with a
 * cached copy serves the stale copy.
 */
export class MongoAstrologerRepository implements AstrologerRepository {
  private cached?: { repo: InMemoryAstrologerRepository; at: number };
  private inflight?: Promise<InMemoryAstrologerRepository>;

  constructor(
    private readonly fallback: AstrologerRepository = new FeedAstrologerRepository(),
    private readonly cacheMs = 5000,
  ) {}

  /** Forget the cached set (after a sync). */
  invalidate(): void {
    this.cached = undefined;
  }

  private async read(): Promise<InMemoryAstrologerRepository> {
    const { astrologers } = await getCollections();
    const docs = await astrologers.find({}, { projection: { syncedAt: 0 } }).toArray();

    const valid: AstrologerProfile[] = [];
    for (const doc of docs) {
      const r = validateAstrologer(stripId(doc));
      if (r.ok) valid.push(r.value);
      else logError(new InvalidAstrologerDataError("Skipping invalid astrologer document", { ref: String(doc._id), issues: r.issues }), { scope: "db" });
    }
    if (valid.length > 0) return new InMemoryAstrologerRepository(valid);

    console.warn("[db] astrologers collection is empty; serving the provider feeds (run `npm run db:sync`)");
    return new InMemoryAstrologerRepository(await this.fallback.list());
  }

  private async load(): Promise<InMemoryAstrologerRepository> {
    if (this.cached && Date.now() - this.cached.at < this.cacheMs) return this.cached.repo;
    this.inflight ??= this.read()
      .then((repo) => {
        this.cached = { repo, at: Date.now() };
        return repo;
      })
      .catch(async (err) => {
        logError(new DatabaseError("Failed to load astrologers", { operation: "find", collection: "astrologers" }, { cause: err }), {
          scope: "db",
        });
        if (this.cached) return this.cached.repo;
        return new InMemoryAstrologerRepository(await this.fallback.list());
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  async list() {
    return (await this.load()).list();
  }

  async getByIds(ids: readonly string[]) {
    return (await this.load()).getByIds(ids);
  }
}

export interface SyncResult {
  upserted: number;
  modified: number;
  removed: number;
}

/**
 * Makes the collection match freshly normalized feeds: upserts every
 * astrologer and removes ones that disappeared — but only for
 * `providerIds` (providers whose feed actually loaded), so a missing file
 * never wipes that provider's astrologers.
 */
export async function syncAstrologers(astrologers: readonly AstrologerProfile[], providerIds: readonly string[]): Promise<SyncResult> {
  const { astrologers: col } = await getCollections();
  const syncedAt = Date.now();
  const ops: AnyBulkWriteOperation<AstrologerDoc>[] = astrologers.map((a) => ({
    replaceOne: { filter: { _id: a.id }, replacement: { ...a, syncedAt }, upsert: true },
  }));

  try {
    const write = ops.length ? await col.bulkWrite(ops, { ordered: false }) : null;
    const removed = providerIds.length
      ? await col.deleteMany({ providerId: { $in: [...providerIds] }, _id: { $nin: astrologers.map((a) => a.id) } })
      : { deletedCount: 0 };
    return { upserted: write?.upsertedCount ?? 0, modified: write?.modifiedCount ?? 0, removed: removed.deletedCount };
  } catch (err) {
    throw new DatabaseError("Failed to sync astrologers", { operation: "sync", collection: "astrologers" }, { cause: err });
  }
}

export async function countAstrologers(): Promise<number> {
  const { astrologers } = await getCollections();
  return astrologers.estimatedDocumentCount();
}
