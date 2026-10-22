import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@/config";
import { getDb, isDatabaseConfigured } from "@/db/client";
import { DatabaseError, InternalError, logError } from "@/lib/errors";
import type { DayHours, PortalSettings } from "./types";

/*
 * Per-astrologer portal settings: MongoDB (collection `astrologer_portal`)
 * when MONGO_URI is set, else data/state/astrologer-portal.json, so they
 * survive restarts. A failing MongoDB falls back to the file.
 */

export interface PortalStore {
  get(astrologerId: string): Promise<PortalSettings | null>;
  save(settings: PortalSettings): Promise<void>;
}

/** New astrologers start on the platform's standard working hours, every day. */
export function defaultSettings(astrologerId: string): PortalSettings {
  const { startMinute, endMinute } = config.booking.workingHours;
  const day: DayHours = { enabled: true, startMinute, endMinute };
  return {
    astrologerId,
    status: "available",
    weeklyHours: Array.from({ length: 7 }, () => ({ ...day })),
    dayOverrides: {},
    blocks: [],
    approvedBookingIds: [],
    notificationsSeenAt: 0,
    updatedAt: 0,
  };
}

export const PORTAL_FILE = path.join(process.cwd(), "data", "state", "astrologer-portal.json");

export class FilePortalStore implements PortalStore {
  // Writes are chained so two quick edits can't overwrite each other's file.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = PORTAL_FILE) {}

  private async readAll(): Promise<Record<string, PortalSettings>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<string, PortalSettings>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new InternalError("Failed to read astrologer portal settings", { cause: err, details: { file: this.file } });
    }
  }

  async get(astrologerId: string) {
    return (await this.readAll())[astrologerId] ?? null;
  }

  save(settings: PortalSettings): Promise<void> {
    const run = this.queue.then(async () => {
      const all = await this.readAll();
      all[settings.astrologerId] = settings;
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
      await rename(tmp, this.file);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

const COLLECTION = "astrologer_portal";
type PortalDoc = PortalSettings & { _id: string };

export class MongoPortalStore implements PortalStore {
  private async collection() {
    return (await getDb()).collection<PortalDoc>(COLLECTION);
  }

  async get(astrologerId: string) {
    try {
      const doc = await (await this.collection()).findOne({ _id: astrologerId });
      if (!doc) return null;
      const { _id, ...settings } = doc;
      void _id;
      return settings;
    } catch (err) {
      throw new DatabaseError("Portal settings load failed", { operation: "get", collection: COLLECTION }, { cause: err });
    }
  }

  async save(settings: PortalSettings) {
    try {
      await (await this.collection()).replaceOne({ _id: settings.astrologerId }, settings, { upsert: true });
    } catch (err) {
      throw new DatabaseError("Portal settings save failed", { operation: "save", collection: COLLECTION }, { cause: err });
    }
  }
}

/** How long to stay on the fallback after the primary fails before trying it again. */
const RETRY_PRIMARY_MS = 30_000;

/** Uses `primary`; while it's failing, `fallback`, retrying `primary` every RETRY_PRIMARY_MS. */
class FallbackPortalStore implements PortalStore {
  /** While the primary is down: fall back until then, then try it again. */
  private retryAt = 0;

  constructor(
    private readonly primary: PortalStore,
    private readonly fallback: PortalStore,
  ) {}

  private async run<T>(fn: (s: PortalStore) => Promise<T>): Promise<T> {
    if (Date.now() >= this.retryAt) {
      try {
        const out = await fn(this.primary);
        this.retryAt = 0;
        return out;
      } catch (err) {
        logError(err, { scope: "astrologer-portal", operation: "store" });
        console.warn("[astrologer-portal] settings store unavailable; using the local state file");
        this.retryAt = Date.now() + RETRY_PRIMARY_MS;
      }
    }
    return fn(this.fallback);
  }

  get(astrologerId: string) {
    return this.run((s) => s.get(astrologerId));
  }

  save(settings: PortalSettings) {
    return this.run((s) => s.save(settings));
  }
}

const g = globalThis as unknown as { __portalStore?: PortalStore; __portalStoreIsDefault?: boolean };

export function getPortalStore(): PortalStore {
  // A default store built by an older copy of this module (dev hot reload) may lack newer methods: replace it.
  if (g.__portalStoreIsDefault !== false && !(g.__portalStore instanceof FallbackPortalStore || g.__portalStore instanceof FilePortalStore)) {
    g.__portalStore = isDatabaseConfigured() ? new FallbackPortalStore(new MongoPortalStore(), new FilePortalStore()) : new FilePortalStore();
    g.__portalStoreIsDefault = true;
  }
  return g.__portalStore!;
}

export function setPortalStore(store: PortalStore): void {
  g.__portalStore = store;
  g.__portalStoreIsDefault = false;
}
