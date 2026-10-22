import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MongoServerError, type Filter } from "mongodb";
import { getDb, isDatabaseConfigured } from "@/db/client";
import { config } from "@/config";
import { getBookingStore } from "@/lib/booking";
import { DURATIONS, priceFor, type DurationMinutes } from "@/lib/consultation/offers";
import { AppError, DatabaseError, InternalError, logError, NotFoundError } from "@/lib/errors";
import { getFirstOutPool } from "@/lib/ranking/first-out";

/*
 * Payments for First-Out bookings (the /user duration cards). The user
 * pays first; the booking is made against the paid payment:
 *
 *   paid ──claim──▶ (booking) ──▶ paid + bookingId
 *     └─ booking failed: claim released, the payment can book again
 *     └─ abandoned unused: refund_due
 *
 * There is no payment gateway yet: `createPayment` records the charge as
 * paid straight away (method "simulated"). The amount is the card's price
 * computed here, never taken from the client. A payment books at most
 * once: booking claims it with a compare-and-set, and its id is the
 * booking's idempotency key.
 */

export type PaymentStatus = "paid" | "refund_due";

export interface Payment {
  paymentId: string;
  /** Client key for the Pay click; the same key returns the same payment. */
  payKey: string;
  userId: string;
  minutes: DurationMinutes;
  /** INR */
  amount: number;
  currency: "INR";
  method: "simulated";
  status: PaymentStatus;
  /** Set once the payment has booked. */
  bookingId: string | null;
  /** A booking attempt in progress holds the payment until then. */
  claimedUntil: number;
  createdAt: number;
  paidAt: number;
  updatedAt: number;
}

/* ───────────────────────────── store ───────────────────────────── */

interface PaymentStore {
  get(paymentId: string): Promise<Payment | null>;
  byKey(payKey: string): Promise<Payment | null>;
  /** Inserts; a duplicate payKey returns the existing payment instead. */
  insert(p: Payment): Promise<Payment>;
  /** Applies `patch` only while the payment still matches `expect`; null if it doesn't. */
  update(paymentId: string, expect: (p: Payment) => boolean, filter: Filter<PaymentDoc>, patch: Partial<Payment>): Promise<Payment | null>;
}

type PaymentDoc = Payment & { _id: string };
const COLLECTION = "payments";
const FILE = path.join(process.cwd(), "data", "state", "payments.json");

class FilePaymentStore implements PaymentStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = FILE) {}

  private async all(): Promise<Record<string, Payment>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<string, Payment>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new InternalError("Failed to read payments", { cause: err, details: { file: this.file } });
    }
  }

  /** Read-modify-write, one at a time, so compare-and-set holds within the process. */
  private write<T>(fn: (all: Record<string, Payment>) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const all = await this.all();
      const out = fn(all);
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
      await rename(tmp, this.file);
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async get(id: string) {
    return (await this.all())[id] ?? null;
  }

  async byKey(payKey: string) {
    return Object.values(await this.all()).find((p) => p.payKey === payKey) ?? null;
  }

  insert(p: Payment) {
    return this.write((all) => {
      const existing = Object.values(all).find((x) => x.payKey === p.payKey);
      if (existing) return existing;
      all[p.paymentId] = p;
      return p;
    });
  }

  update(id: string, expect: (p: Payment) => boolean, _filter: Filter<PaymentDoc>, patch: Partial<Payment>) {
    return this.write((all) => {
      const p = all[id];
      if (!p || !expect(p)) return null;
      all[id] = { ...p, ...patch };
      return all[id];
    });
  }
}

class MongoPaymentStore implements PaymentStore {
  private indexed?: Promise<unknown>;

  private async collection() {
    const c = (await getDb()).collection<PaymentDoc>(COLLECTION);
    this.indexed ??= c.createIndexes([{ key: { payKey: 1 }, unique: true }, { key: { userId: 1, createdAt: -1 } }]).catch((err) => {
      this.indexed = undefined;
      throw err;
    });
    await this.indexed;
    return c;
  }

  private async run<T>(operation: string, fn: (c: Awaited<ReturnType<MongoPaymentStore["collection"]>>) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.collection());
    } catch (err) {
      throw new DatabaseError(`Payment store ${operation} failed`, { operation, collection: COLLECTION }, { cause: err });
    }
  }

  private static strip(doc: PaymentDoc | null): Payment | null {
    if (!doc) return null;
    const { _id, ...p } = doc;
    void _id;
    return p;
  }

  get(id: string) {
    return this.run("get", async (c) => MongoPaymentStore.strip(await c.findOne({ _id: id })));
  }

  byKey(payKey: string) {
    return this.run("byKey", async (c) => MongoPaymentStore.strip(await c.findOne({ payKey })));
  }

  insert(p: Payment) {
    return this.run("insert", async (c) => {
      try {
        await c.insertOne({ ...p, _id: p.paymentId });
        return p;
      } catch (err) {
        // The unique payKey index makes a repeated Pay click return the first payment.
        if (err instanceof MongoServerError && err.code === 11000) {
          const existing = MongoPaymentStore.strip(await c.findOne({ payKey: p.payKey }));
          if (existing) return existing;
        }
        throw err;
      }
    });
  }

  update(id: string, _expect: (p: Payment) => boolean, filter: Filter<PaymentDoc>, patch: Partial<Payment>) {
    return this.run("update", async (c) => MongoPaymentStore.strip(await c.findOneAndUpdate({ ...filter, _id: id }, { $set: patch }, { returnDocument: "after" })));
  }
}

const g = globalThis as unknown as { __paymentStore?: PaymentStore; __paymentStoreIsDefault?: boolean };

function store(): PaymentStore {
  // A default store built by an older copy of this module (dev hot reload) may lack newer methods: replace it.
  if (g.__paymentStoreIsDefault !== false && !(g.__paymentStore instanceof MongoPaymentStore || g.__paymentStore instanceof FilePaymentStore)) {
    g.__paymentStore = isDatabaseConfigured() ? new MongoPaymentStore() : new FilePaymentStore();
    g.__paymentStoreIsDefault = true;
  }
  return g.__paymentStore!;
}

/** Tests: a payment store backed by this file. */
export function usePaymentFile(file: string): void {
  g.__paymentStore = new FilePaymentStore(file);
  g.__paymentStoreIsDefault = false;
}

/* ───────────────────────────── payments ───────────────────────────── */

/** What a duration card costs right now: the cheapest price among those who can take it (what the card shows). */
export async function cardPrice(minutes: DurationMinutes, now = Date.now()): Promise<number> {
  const pool = await getFirstOutPool(minutes, now);
  if (pool.length === 0) throw new AppError("NO_ASTROLOGER_AVAILABLE", `Nobody takes ${minutes}-minute calls right now`);
  return Math.min(...pool.map((a) => priceFor(a, minutes)));
}

/** Charges the card and records the payment as paid. The same `payKey` returns the same payment. */
export async function createPayment(input: { userId: string; minutes: DurationMinutes; payKey: string }, now = Date.now()): Promise<Payment> {
  const existing = await store().byKey(input.payKey);
  if (existing) return existing;
  if (!(DURATIONS as readonly number[]).includes(input.minutes)) throw new NotFoundError("duration", String(input.minutes));
  // Don't charge someone who can't book: the same limit the booking enforces.
  const active = await getBookingStore().list({ userId: input.userId, from: now, to: Number.MAX_SAFE_INTEGER });
  if (active.length >= config.booking.maxUpcomingPerUser) {
    throw new AppError("ACTIVE_BOOKING_EXISTS", `User has ${active.length} active bookings`, { details: { userId: input.userId } });
  }
  const amount = await cardPrice(input.minutes, now);
  // Simulated gateway: the charge succeeds immediately.
  return store().insert({
    paymentId: `pay_${crypto.randomUUID()}`,
    payKey: input.payKey,
    userId: input.userId,
    minutes: input.minutes,
    amount,
    currency: "INR",
    method: "simulated",
    status: "paid",
    bookingId: null,
    claimedUntil: 0,
    createdAt: now,
    paidAt: now,
    updatedAt: now,
  });
}

export async function getPayment(paymentId: string): Promise<Payment | null> {
  return store().get(paymentId);
}

const CLAIM_MS = 60_000;

export type Claim = { kind: "claimed"; payment: Payment } | { kind: "booked"; payment: Payment };

/**
 * Takes the payment for one booking attempt. A payment that already booked
 * says so (the caller replays that booking); one being booked by another
 * request right now is refused, so it can't book twice.
 */
export async function claimPayment(paymentId: string, userId: string, minutes: number, now = Date.now()): Promise<Claim> {
  const p = await store().get(paymentId);
  if (!p || p.userId !== userId) throw new NotFoundError("payment", paymentId);
  if (p.minutes !== minutes) throw new AppError("PAYMENT_NOT_USABLE", `Payment ${paymentId} is for ${p.minutes} minutes, not ${minutes}`);
  if (p.bookingId) return { kind: "booked", payment: p };
  if (p.status !== "paid") throw new AppError("PAYMENT_NOT_USABLE", `Payment ${paymentId} is ${p.status}`);

  const claimed = await store().update(
    paymentId,
    (x) => x.status === "paid" && x.bookingId === null && x.claimedUntil < now,
    { status: "paid", bookingId: null, claimedUntil: { $lt: now } },
    { claimedUntil: now + CLAIM_MS, updatedAt: now },
  );
  if (claimed) return { kind: "claimed", payment: claimed };
  const after = await store().get(paymentId);
  if (after?.bookingId) return { kind: "booked", payment: after };
  throw new AppError("PAYMENT_IN_PROGRESS", `Payment ${paymentId} is already being booked`);
}

/** The claimed attempt booked: the payment is spent on that booking. */
export async function settlePayment(paymentId: string, bookingId: string, now = Date.now()): Promise<void> {
  await store().update(paymentId, (x) => x.bookingId === null, { bookingId: null }, { bookingId, claimedUntil: 0, updatedAt: now });
}

/** The claimed attempt failed: the payment stays paid and can book again. */
export async function releasePayment(paymentId: string, now = Date.now()): Promise<void> {
  try {
    await store().update(paymentId, (x) => x.bookingId === null, { bookingId: null }, { claimedUntil: 0, updatedAt: now });
  } catch (err) {
    logError(err, { scope: "payments", operation: "release", paymentId });
  }
}

/** The user gave up on an unused payment: it is owed back. */
export async function refundUnusedPayment(paymentId: string, userId: string, now = Date.now()): Promise<Payment> {
  const p = await store().get(paymentId);
  if (!p || p.userId !== userId) throw new NotFoundError("payment", paymentId);
  if (p.bookingId) return p;
  const done = await store().update(
    paymentId,
    (x) => x.bookingId === null && x.status === "paid" && x.claimedUntil < now,
    { bookingId: null, status: "paid", claimedUntil: { $lt: now } },
    { status: "refund_due", updatedAt: now },
  );
  return done ?? (await store().get(paymentId)) ?? p;
}
