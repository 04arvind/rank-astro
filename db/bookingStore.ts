import { MongoServerError, type Filter } from "mongodb";
import { needsConflictCheck, type BookingExpectation, type BookingPatch, type BookingQuery, type BookingStore, type NotificationStore } from "@/lib/booking/store";
import { DatabaseError, SlotUnavailableError } from "@/lib/errors";
import type { AstrologerNotification, Booking } from "@/types/booking";
import { getCollections, stripId, type BookingDoc, type Collections } from "./collections";

const DUPLICATE_KEY = 11000;

async function run<T>(operation: string, collection: string, fn: (c: Collections) => Promise<T>): Promise<T> {
  const c = await getCollections();
  try {
    return await fn(c);
  } catch (err) {
    if (err instanceof SlotUnavailableError) throw err;
    throw new DatabaseError(`Booking store ${operation} failed`, { operation, collection }, { cause: err });
  }
}

const overlapping = (from: number, to: number) => ({ startAt: { $lt: to }, endAt: { $gt: from } });

/**
 * Bookings in the `bookings` collection, _id = bookingId. The overlap check
 * catches bookings of any length; the unique (astrologerId|userId, startAt)
 * indexes on confirmed bookings (db/collections.ts) close the race between
 * two concurrent requests for the same slot.
 */
async function assertFree(c: Collections, booking: Booking): Promise<void> {
  const clash = await c.bookings.findOne(
    {
      _id: { $ne: booking.bookingId },
      status: "confirmed",
      $or: [{ astrologerId: booking.astrologerId }, { userId: booking.userId }],
      ...overlapping(booking.startAt, booking.endAt),
    },
    { projection: { astrologerId: 1 } },
  );
  if (clash) {
    throw new SlotUnavailableError(clash.astrologerId === booking.astrologerId ? "astrologer_busy" : "user_busy", booking);
  }
}

/** The unique slot indexes are the last line against a race: map their violation to a busy slot. */
async function orSlotTaken<T>(booking: Booking, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) {
      throw new SlotUnavailableError(err.keyPattern?.userId ? "user_busy" : "astrologer_busy", booking, { cause: err });
    }
    throw err;
  }
}

export class MongoBookingStore implements BookingStore {
  async create(booking: Booking): Promise<void> {
    await run("create", "bookings", async (c) => {
      await assertFree(c, booking);
      await orSlotTaken(booking, () => c.bookings.insertOne({ ...booking, _id: booking.bookingId }));
    });
  }

  async get(bookingId: string): Promise<Booking | null> {
    const doc = await run("get", "bookings", (c) => c.bookings.findOne({ _id: bookingId }));
    return doc ? stripId(doc) : null;
  }

  async update(bookingId: string, expect: BookingExpectation, patch: BookingPatch): Promise<Booking | null> {
    return run("update", "bookings", async (c) => {
      const filter: Filter<BookingDoc> = { _id: bookingId, status: expect.status };
      if (expect.astrologerId !== undefined) filter.astrologerId = expect.astrologerId;
      const current = await c.bookings.findOne(filter);
      if (!current) return null;
      const next = { ...stripId(current), ...patch };
      if (needsConflictCheck(stripId(current), patch)) await assertFree(c, next);
      const doc = await orSlotTaken(next, () => c.bookings.findOneAndUpdate(filter, { $set: patch }, { returnDocument: "after" }));
      return doc ? stripId(doc) : null;
    });
  }

  async list(q: BookingQuery): Promise<Booking[]> {
    const filter: Filter<BookingDoc> = { status: { $in: q.statuses ?? ["confirmed"] }, ...overlapping(q.from, q.to) };
    if (q.astrologerId) filter.astrologerId = q.astrologerId;
    if (q.userId) filter.userId = q.userId;
    const docs = await run("list", "bookings", (c) => c.bookings.find(filter).sort({ startAt: 1 }).toArray());
    return docs.map((d) => stripId(d));
  }
}

/** Astrologer notifications in `astrologer_notifications`, _id = notificationId. */
export class MongoNotificationStore implements NotificationStore {
  async append(n: AstrologerNotification): Promise<void> {
    await run("append", "astrologer_notifications", (c) => c.notifications.insertOne({ ...n, _id: n.notificationId }));
  }

  async listForAstrologer(astrologerId: string, { unreadOnly = false, limit }: { unreadOnly?: boolean; limit: number }) {
    const docs = await run("listForAstrologer", "astrologer_notifications", (c) =>
      c.notifications
        .find(unreadOnly ? { astrologerId, readAt: null } : { astrologerId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray(),
    );
    return docs.map((d) => stripId(d));
  }

  async markRead(astrologerId: string, notificationIds: readonly string[], at: number): Promise<number> {
    const res = await run("markRead", "astrologer_notifications", (c) =>
      c.notifications.updateMany({ astrologerId, _id: { $in: [...notificationIds] }, readAt: null }, { $set: { readAt: at } }),
    );
    return res.modifiedCount;
  }
}
