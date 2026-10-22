import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { InternalError, InvalidAstrologerDataError, logError } from "@/lib/errors";
import { listProviders, loadProviderRecords } from "@/lib/providers";
import type { AstrologerProfile } from "@/types/astrologer";
import { normalizeFeeds } from "./normalize";
import { validateAstrologer } from "./validation";

/**
 * Source of normalized astrologers. The default reads the provider feed
 * files in data/csv (FeedAstrologerRepository), falling back to the JSON
 * snapshot written by scripts/normalize-data.ts; swap in a DB-backed
 * implementation with setAstrologerRepository().
 */
export interface AstrologerRepository {
  list(): Promise<AstrologerProfile[]>;
  getByIds(ids: readonly string[]): Promise<AstrologerProfile[]>;
}

export class InMemoryAstrologerRepository implements AstrologerRepository {
  private readonly byId: Map<string, AstrologerProfile>;

  constructor(astrologers: readonly AstrologerProfile[]) {
    this.byId = new Map(astrologers.map((a) => [a.id, a]));
  }

  async list() {
    return [...this.byId.values()];
  }

  async getByIds(ids: readonly string[]) {
    return ids.map((id) => this.byId.get(id)).filter((a): a is AstrologerProfile => a !== undefined);
  }
}

export const NORMALIZED_SNAPSHOT = path.join(process.cwd(), "data", "normalized", "astrologers.json");

/** Loads the normalized snapshot once; re-validates so a hand-edited file can't poison ranking. */
/**
 * Serves the normalized snapshot, re-validating rows so a hand-edited file
 * can't poison ranking. Reloads automatically when the file changes (e.g.
 * after `npm run data:normalize`), checked at most every `checkIntervalMs`.
 */
export class SnapshotAstrologerRepository implements AstrologerRepository {
  private loaded?: Promise<InMemoryAstrologerRepository>;
  private version: number | null = null; // file mtime; -1 = missing
  private checkedAt = 0;

  constructor(
    private readonly file = NORMALIZED_SNAPSHOT,
    private readonly checkIntervalMs = 2000,
  ) {}

  private async currentVersion(): Promise<number> {
    try {
      return (await stat(this.file)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return -1;
      throw new InternalError("Failed to stat astrologer snapshot", { cause: err, details: { file: this.file } });
    }
  }

  private async load(): Promise<InMemoryAstrologerRepository> {
    const now = Date.now();
    if (this.loaded && now - this.checkedAt < this.checkIntervalMs) return this.loaded;
    this.checkedAt = now;

    const version = await this.currentVersion();
    if (this.loaded && version === this.version) return this.loaded;
    this.version = version;
    this.loaded = version === -1 ? Promise.resolve(this.empty()) : this.read();
    return this.loaded;
  }

  private empty() {
    console.warn(`[astrologer] no snapshot at ${this.file}; repository is empty (run \`npm run data:normalize\`)`);
    return new InMemoryAstrologerRepository([]);
  }

  private async read(): Promise<InMemoryAstrologerRepository> {
    let rows: unknown[];
    try {
      rows = JSON.parse(await readFile(this.file, "utf8")) as unknown[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      this.version = null; // retry on next call
      throw new InternalError("Failed to load astrologer snapshot", { cause: err, details: { file: this.file } });
    }
    const valid: AstrologerProfile[] = [];
    for (const row of rows) {
      const r = validateAstrologer(row);
      if (r.ok) valid.push(r.value);
      else
        logError(new InvalidAstrologerDataError("Skipping invalid snapshot row", { ref: this.file, issues: r.issues }), {
          scope: "astrologer",
        });
    }
    return new InMemoryAstrologerRepository(valid);
  }

  async list() {
    return (await this.load()).list();
  }

  async getByIds(ids: readonly string[]) {
    return (await this.load()).getByIds(ids);
  }
}

/**
 * Reads every enabled provider's feed file (data/csv/*) directly and
 * normalizes it through the provider adapters — the same path
 * `npm run data:normalize` takes, without the intermediate snapshot.
 * Reloads when any feed file changes (checked at most every
 * `checkIntervalMs`). A feed that fails to load is logged and skipped; if
 * none load, falls back to the normalized snapshot.
 */
export class FeedAstrologerRepository implements AstrologerRepository {
  private loaded?: Promise<InMemoryAstrologerRepository>;
  private version: string | null = null;
  private checkedAt = 0;

  constructor(
    private readonly fallback: AstrologerRepository = new SnapshotAstrologerRepository(),
    private readonly checkIntervalMs = 2000,
  ) {}

  private feeds(): { providerId: string; file: string }[] {
    return listProviders({ enabledOnly: true })
      .filter((p) => p.adapter.feed.defaultPath)
      .map((p) => ({ providerId: p.id, file: p.adapter.feed.defaultPath! }));
  }

  /** Feed files' mtimes; a missing file counts as -1. */
  private async currentVersion(): Promise<string> {
    const stamps = await Promise.all(
      this.feeds().map(({ file }) =>
        stat(path.resolve(process.cwd(), file)).then(
          (s) => s.mtimeMs,
          () => -1,
        ),
      ),
    );
    return stamps.join("|");
  }

  private async load(): Promise<InMemoryAstrologerRepository> {
    const now = Date.now();
    if (this.loaded && now - this.checkedAt < this.checkIntervalMs) return this.loaded;
    this.checkedAt = now;

    const version = await this.currentVersion();
    if (this.loaded && version === this.version) return this.loaded;
    this.version = version;
    this.loaded = this.read().catch((err) => {
      this.version = null; // retry on next call
      throw err;
    });
    return this.loaded;
  }

  private async read(): Promise<InMemoryAstrologerRepository> {
    const feeds: Record<string, unknown[]> = {};
    for (const { providerId, file } of this.feeds()) {
      try {
        feeds[providerId] = await loadProviderRecords(providerId, file);
      } catch (err) {
        logError(err, { scope: "astrologer", providerId, file });
      }
    }

    const { astrologers, rejected } = normalizeFeeds(feeds);
    for (const r of rejected) {
      logError(new InvalidAstrologerDataError("Skipping invalid feed row", { ref: `${r.providerId} ${r.ref}`, issues: r.issues }), {
        scope: "astrologer",
      });
    }
    if (astrologers.length > 0) return new InMemoryAstrologerRepository(astrologers);

    console.warn("[astrologer] no astrologers loaded from provider feeds; falling back to the normalized snapshot");
    return new InMemoryAstrologerRepository(await this.fallback.list());
  }

  async list() {
    return (await this.load()).list();
  }

  async getByIds(ids: readonly string[]) {
    return (await this.load()).getByIds(ids);
  }
}

const g = globalThis as unknown as { __astrologerRepo?: AstrologerRepository; __astrologerRepoIsDefault?: boolean };

export function getAstrologerRepository(): AstrologerRepository {
  // A default instance created by an older copy of this module (dev hot
  // reload) is replaced, so code changes take effect without a restart.
  if (g.__astrologerRepoIsDefault !== false && !(g.__astrologerRepo instanceof FeedAstrologerRepository)) {
    g.__astrologerRepo = undefined;
  }
  if (!g.__astrologerRepo) {
    g.__astrologerRepo = new FeedAstrologerRepository();
    g.__astrologerRepoIsDefault = true;
  }
  return g.__astrologerRepo;
}

export function setAstrologerRepository(repo: AstrologerRepository): void {
  g.__astrologerRepo = repo;
  g.__astrologerRepoIsDefault = false;
}
