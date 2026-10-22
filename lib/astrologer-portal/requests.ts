import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb, isDatabaseConfigured } from "@/db/client";
import { DatabaseError, InternalError, logError } from "@/lib/errors";
import type { Booking, BookingKind } from "@/types/booking";

/*
 * Consultation requests: one record per (booking, astrologer) assignment,
 * holding what the astrologer needs to decide — who the user is, the topic
 * and language they asked about — and the astrologer's decision.
 *
 *   pending → accepted | rejected
 *
 * A First-Out booking an astrologer rejects moves to the next astrologer in
 * the rotation, who gets a new pending request; the rejected record stays
 * with the first astrologer as history. MongoDB (`consultation_requests`)
 * when MONGO_URI is set, else data/state/consultation-requests.json.
 */

export type RequestStatus = "pending" | "accepted" | "rejected";
export type RequestSource = "first_out" | "user_choice";

export interface RequestDetails {
  customer: { name: string; mobile: string; city: string } | null;
  /** Topic / subject the user picked, as shown to them. */
  topic: string | null;
  language: string | null;
}

export interface ConsultationRequest extends RequestDetails {
  /** `${bookingId}:${astrologerId}` */
  id: string;
  bookingId: string;
  astrologerId: string;
  userId: string;
  source: RequestSource;
  /** Client key for the Pay click that created the booking; only on the first assignment. */
  requestKey?: string;
  /** The booking as assigned, so a rejected request still shows its details. */
  kind: BookingKind;
  startAt: number;
  endAt: number;
  pickupBy: number | null;
  durationMinutes: number;
  pricePerMinute: number;
  status: RequestStatus;
  createdAt: number;
  decidedAt: number | null;
  /** Why it was rejected, and what happened to the booking. */
  note?: string;
  /** First-Out: the user paid before the booking was made. */
  payment?: { paymentId: string; amount: number; status: "paid" };
}

export const requestId = (bookingId: string, astrologerId: string) => `${bookingId}:${astrologerId}`;

export function requestFor(
  b: Booking,
  details: RequestDetails,
  opts: { source: RequestSource; requestKey?: string; now: number },
): ConsultationRequest {
  return {
    id: requestId(b.bookingId, b.astrologerId),
    bookingId: b.bookingId,
    astrologerId: b.astrologerId,
    userId: b.userId,
    source: opts.source,
    requestKey: opts.requestKey,
    kind: b.kind ?? "scheduled",
    startAt: b.startAt,
    endAt: b.endAt,
    pickupBy: b.pickupBy ?? null,
    durationMinutes: b.durationMinutes,
    pricePerMinute: b.pricePerMinute,
    status: "pending",
    createdAt: opts.now,
    decidedAt: null,
    ...details,
  };
}

/* ───────────────────────────── store ───────────────────────────── */

export interface RequestStore {
  get(id: string): Promise<ConsultationRequest | null>;
  put(r: ConsultationRequest): Promise<void>;
  byKey(requestKey: string): Promise<ConsultationRequest | null>;
  forAstrologer(astrologerId: string): Promise<ConsultationRequest[]>;
  forBooking(bookingId: string): Promise<ConsultationRequest[]>;
  forBookings(bookingIds: readonly string[]): Promise<ConsultationRequest[]>;
}

export const REQUESTS_FILE = path.join(process.cwd(), "data", "state", "consultation-requests.json");

export class FileRequestStore implements RequestStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = REQUESTS_FILE) {}

  private async all(): Promise<Record<string, ConsultationRequest>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<string, ConsultationRequest>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new InternalError("Failed to read consultation requests", { cause: err, details: { file: this.file } });
    }
  }

  async get(id: string) {
    return (await this.all())[id] ?? null;
  }

  put(r: ConsultationRequest): Promise<void> {
    const run = this.queue.then(async () => {
      const all = await this.all();
      all[r.id] = r;
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
      await rename(tmp, this.file);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async byKey(requestKey: string) {
    return Object.values(await this.all()).find((r) => r.requestKey === requestKey) ?? null;
  }

  async forAstrologer(astrologerId: string) {
    return Object.values(await this.all()).filter((r) => r.astrologerId === astrologerId);
  }

  async forBooking(bookingId: string) {
    return Object.values(await this.all()).filter((r) => r.bookingId === bookingId);
  }

  async forBookings(bookingIds: readonly string[]) {
    const ids = new Set(bookingIds);
    return Object.values(await this.all()).filter((r) => ids.has(r.bookingId));
  }
}

const COLLECTION = "consultation_requests";
type RequestDoc = ConsultationRequest & { _id: string };

export class MongoRequestStore implements RequestStore {
  private indexed?: Promise<unknown>;

  private async collection() {
    const c = (await getDb()).collection<RequestDoc>(COLLECTION);
    this.indexed ??= c
      .createIndexes([
        { key: { astrologerId: 1, createdAt: -1 } },
        { key: { bookingId: 1 } },
        { key: { requestKey: 1 }, unique: true, partialFilterExpression: { requestKey: { $type: "string" } } },
      ])
      .catch((err) => {
        this.indexed = undefined;
        throw err;
      });
    await this.indexed;
    return c;
  }

  private async run<T>(operation: string, fn: (c: Awaited<ReturnType<MongoRequestStore["collection"]>>) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.collection());
    } catch (err) {
      throw new DatabaseError(`Request store ${operation} failed`, { operation, collection: COLLECTION }, { cause: err });
    }
  }

  private static strip(doc: RequestDoc | null): ConsultationRequest | null {
    if (!doc) return null;
    const { _id, ...r } = doc;
    void _id;
    return r;
  }

  get(id: string) {
    return this.run("get", async (c) => MongoRequestStore.strip(await c.findOne({ _id: id })));
  }

  async put(r: ConsultationRequest) {
    await this.run("put", (c) => c.replaceOne({ _id: r.id }, r, { upsert: true }));
  }

  byKey(requestKey: string) {
    return this.run("byKey", async (c) => MongoRequestStore.strip(await c.findOne({ requestKey })));
  }

  forAstrologer(astrologerId: string) {
    return this.run("forAstrologer", async (c) => (await c.find({ astrologerId }).toArray()).map((d) => MongoRequestStore.strip(d)!));
  }

  forBooking(bookingId: string) {
    return this.run("forBooking", async (c) => (await c.find({ bookingId }).toArray()).map((d) => MongoRequestStore.strip(d)!));
  }

  forBookings(bookingIds: readonly string[]) {
    if (bookingIds.length === 0) return Promise.resolve([]);
    return this.run("forBookings", async (c) => (await c.find({ bookingId: { $in: [...bookingIds] } }).toArray()).map((d) => MongoRequestStore.strip(d)!));
  }
}

/** How long to stay on the fallback after the primary fails before trying it again. */
const RETRY_PRIMARY_MS = 30_000;

/** Uses `primary`; while it's failing, `fallback`, retrying `primary` every RETRY_PRIMARY_MS. */
class FallbackRequestStore implements RequestStore {
  /** While the primary is down: fall back until then, then try it again. */
  private retryAt = 0;

  constructor(
    private readonly primary: RequestStore,
    private readonly fallback: RequestStore,
  ) {}

  private async run<T>(fn: (s: RequestStore) => Promise<T>): Promise<T> {
    if (Date.now() >= this.retryAt) {
      try {
        const out = await fn(this.primary);
        this.retryAt = 0;
        return out;
      } catch (err) {
        logError(err, { scope: "astrologer-portal", operation: "requests" });
        console.warn("[astrologer-portal] request store unavailable; using the local state file");
        this.retryAt = Date.now() + RETRY_PRIMARY_MS;
      }
    }
    return fn(this.fallback);
  }

  get(id: string) {
    return this.run((s) => s.get(id));
  }
  put(r: ConsultationRequest) {
    return this.run((s) => s.put(r));
  }
  byKey(k: string) {
    return this.run((s) => s.byKey(k));
  }
  forAstrologer(id: string) {
    return this.run((s) => s.forAstrologer(id));
  }
  forBooking(id: string) {
    return this.run((s) => s.forBooking(id));
  }
  forBookings(ids: readonly string[]) {
    return this.run((s) => s.forBookings(ids));
  }
}

const g = globalThis as unknown as { __requestStore?: RequestStore; __requestStoreIsDefault?: boolean };

export function getRequestStore(): RequestStore {
  // A default store built by an older copy of this module (dev hot reload) lacks newer methods: replace it.
  if (g.__requestStoreIsDefault !== false && !(g.__requestStore instanceof FallbackRequestStore || g.__requestStore instanceof FileRequestStore)) {
    g.__requestStore = isDatabaseConfigured() ? new FallbackRequestStore(new MongoRequestStore(), new FileRequestStore()) : new FileRequestStore();
    g.__requestStoreIsDefault = true;
  }
  return g.__requestStore!;
}

export function setRequestStore(store: RequestStore): void {
  g.__requestStore = store;
  g.__requestStoreIsDefault = false;
}
