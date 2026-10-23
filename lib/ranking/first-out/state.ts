import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MongoServerError } from "mongodb";
import { getDb, isDatabaseConfigured } from "@/db/client";
import { DatabaseError, InternalError, logError } from "@/lib/errors";

/*
 * Persistent First-Out round-robin state, so allocation picks up where it
 * left off after a restart. MongoDB (collection `first_out_allocation`)
 * when MONGO_URI is set, else a JSON file under data/state/. A failing
 * MongoDB falls back to the file rather than failing the booking.
 *
 * `lock()` makes an allocation atomic across server processes: a lease in
 * MongoDB, or a lock file next to the state file. Whoever holds it reads
 * the cursor, books, and writes the cursor back before anyone else reads.
 */

/** Releases a lock taken with `lock()`. */
export type Release = () => Promise<void>;

/** A crashed holder's lock is taken over after this long. */
const LEASE_MS = 30_000;
/** How long to wait for the lock before giving up. */
const WAIT_MS = 15_000;
const RETRY_MS = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lockTimeout = (where: string) => new InternalError("Timed out waiting for the First-Out allocation lock", { details: { where } });

export interface SheetCursor {
  /** Roster position the sheet's next turn starts at. */
  next: number;
  /** Who the sheet's last turn went to; re-anchors `next` if the roster changed. */
  lastAstrologerId: string | null;
}

export interface RoundRobinState {
  /** Index (into the enabled providers, config order) of the sheet whose turn is next. */
  nextSheet: number;
  /** Provider id → its cursor. */
  sheets: Record<string, SheetCursor>;
  /** Provider id → weighted round-robin credit (smooth WRR; weight = its free astrologers). */
  credits: Record<string, number>;
  /** Astrologer id → when they were last allocated a First-Out call (longest idle goes first). */
  lastServedAt: Record<string, number>;
  /** Total First-Out allocations made. */
  allocations: number;
  updatedAt: number;
}

export interface RoundRobinStateStore {
  load(): Promise<RoundRobinState>;
  save(state: RoundRobinState): Promise<void>;
  /** Waits for the allocation lock; only its holder may load-allocate-save. */
  lock(): Promise<Release>;
}

export const emptyState = (): RoundRobinState => ({ nextSheet: 0, sheets: {}, credits: {}, lastServedAt: {}, allocations: 0, updatedAt: 0 });

export const STATE_FILE = path.join(process.cwd(), "data", "state", "first-out-round-robin.json");

export class FileRoundRobinStateStore implements RoundRobinStateStore {
  constructor(private readonly file = STATE_FILE) {}

  async load(): Promise<RoundRobinState> {
    try {
      return { ...emptyState(), ...(JSON.parse(await readFile(this.file, "utf8")) as Partial<RoundRobinState>) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw new InternalError("Failed to read First-Out round-robin state", { cause: err, details: { file: this.file } });
    }
  }

  /** Write-then-rename, so a crash mid-write never leaves a torn file. */
  async save(state: RoundRobinState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  /** An exclusively created lock file; one older than the lease is from a crashed process and is removed. */
  async lock(): Promise<Release> {
    const lockFile = `${this.file}.lock`;
    await mkdir(path.dirname(this.file), { recursive: true });
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lockFile, "wx");
        await handle.writeFile(`${process.pid} ${Date.now()}`);
        await handle.close();
        return () => unlink(lockFile).catch(() => {});
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const age = await stat(lockFile).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > LEASE_MS) await unlink(lockFile).catch(() => {});
        else if (Date.now() > deadline) throw lockTimeout(lockFile);
        else await sleep(RETRY_MS);
      }
    }
  }
}

const COLLECTION = "first_out_allocation";
const DOC_ID = "round-robin";
const LOCK_ID = "round-robin:lock";
type StateDoc = RoundRobinState & { _id: string };
type LockDoc = { _id: string; owner: string | null; expiresAt: number };
const DUPLICATE_KEY = 11000;

export class MongoRoundRobinStateStore implements RoundRobinStateStore {
  private async collection() {
    return (await getDb()).collection<StateDoc>(COLLECTION);
  }

  async load(): Promise<RoundRobinState> {
    try {
      const doc = await (await this.collection()).findOne({ _id: DOC_ID });
      if (!doc) return emptyState();
      const { _id, ...state } = doc;
      void _id;
      return { ...emptyState(), ...state };
    } catch (err) {
      throw new DatabaseError("First-Out state load failed", { operation: "load", collection: COLLECTION }, { cause: err });
    }
  }

  async save(state: RoundRobinState): Promise<void> {
    try {
      await (await this.collection()).replaceOne({ _id: DOC_ID }, state, { upsert: true });
    } catch (err) {
      throw new DatabaseError("First-Out state save failed", { operation: "save", collection: COLLECTION }, { cause: err });
    }
  }

  /**
   * A lease document: taken by matching it only when free or expired. While
   * someone holds it the upsert collides on _id, and we retry.
   */
  async lock(): Promise<Release> {
    const locks = (await getDb()).collection<LockDoc>(COLLECTION);
    const owner = crypto.randomUUID();
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const now = Date.now();
      try {
        const doc = await locks.findOneAndUpdate(
          { _id: LOCK_ID, expiresAt: { $lt: now } },
          { $set: { owner, expiresAt: now + LEASE_MS } },
          { upsert: true, returnDocument: "after" },
        );
        if (doc?.owner === owner) {
          return async () => {
            await locks.updateOne({ _id: LOCK_ID, owner }, { $set: { owner: null, expiresAt: 0 } }).catch((err) => {
              logError(err, { scope: "first-out", operation: "unlock" });
            });
          };
        }
      } catch (err) {
        if (!(err instanceof MongoServerError && err.code === DUPLICATE_KEY)) {
          throw new DatabaseError("First-Out lock failed", { operation: "lock", collection: COLLECTION }, { cause: err });
        }
      }
      if (Date.now() > deadline) throw lockTimeout(COLLECTION);
      await sleep(RETRY_MS);
    }
  }
}

/** How long to stay on the fallback after the primary fails before trying it again. */
const RETRY_PRIMARY_MS = 30_000;

/** Uses `primary`; while it's failing, `fallback`, retrying `primary` every RETRY_PRIMARY_MS. */
class FallbackStateStore implements RoundRobinStateStore {
  /** While the primary is down: fall back until then, then try it again. */
  private retryAt = 0;

  constructor(
    private readonly primary: RoundRobinStateStore,
    private readonly fallback: RoundRobinStateStore,
  ) {}

  private async run<T>(fn: (s: RoundRobinStateStore) => Promise<T>): Promise<T> {
    if (Date.now() >= this.retryAt) {
      try {
        const out = await fn(this.primary);
        this.retryAt = 0;
        return out;
      } catch (err) {
        logError(err, { scope: "first-out", operation: "state" });
        console.warn("[first-out] round-robin state store unavailable; using the local state file");
        this.retryAt = Date.now() + RETRY_PRIMARY_MS;
      }
    }
    return fn(this.fallback);
  }

  load() {
    return this.run((s) => s.load());
  }

  save(state: RoundRobinState) {
    return this.run((s) => s.save(state));
  }

  lock() {
    return this.run((s) => s.lock());
  }
}

const g = globalThis as unknown as { __firstOutStateStore?: RoundRobinStateStore; __firstOutStateStoreIsDefault?: boolean };

export function getRoundRobinStateStore(): RoundRobinStateStore {
  // A default store built by an older copy of this module (dev hot reload) may lack newer methods: replace it.
  if (g.__firstOutStateStoreIsDefault !== false && !(g.__firstOutStateStore instanceof FallbackStateStore || g.__firstOutStateStore instanceof FileRoundRobinStateStore)) {
    g.__firstOutStateStore = isDatabaseConfigured()
      ? new FallbackStateStore(new MongoRoundRobinStateStore(), new FileRoundRobinStateStore())
      : new FileRoundRobinStateStore();
    g.__firstOutStateStoreIsDefault = true;
  }
  return g.__firstOutStateStore!;
}

export function setRoundRobinStateStore(store: RoundRobinStateStore): void {
  g.__firstOutStateStore = store;
  g.__firstOutStateStoreIsDefault = false;
}
