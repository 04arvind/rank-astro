import { SlotUnavailableError } from "@/lib/errors";
import type { AstrologerNotification, Booking, BookingStatus } from "@/types/booking";

export interface BookingQuery {
  astrologerId?: string;
  userId?: string;
  /** Bookings overlapping [from, to). */
  from: number;
  to: number;
  /** Default: confirmed only. */
  statuses?: BookingStatus[];
}

/**
 * Persistence boundary for bookings. `create` must be atomic with respect
 * to conflicts: it throws SlotUnavailableError if the astrologer or the
 * user already has a confirmed booking overlapping the new one, so two
 * users racing for one slot can't both win. Swap the in-memory store for a
 * DB-backed one with setBookingStore().
 */
export interface BookingStore {
  create(booking: Booking): Promise<void>;
  /** Bookings matching the query (confirmed unless `statuses` says otherwise), earliest first. */
  list(q: BookingQuery): Promise<Booking[]>;
  get(bookingId: string): Promise<Booking | null>;
  /**
   * Compare-and-set: applies `patch` only while the booking still has
   * `expect.status` (and, if given, `expect.astrologerId`); returns the
   * updated booking, or null if it changed meanwhile. A patch that leaves
   * the booking confirmed under a new astrologer, or re-confirms it, is
   * conflict-checked like create and throws SlotUnavailableError on a clash.
   */
  update(bookingId: string, expect: BookingExpectation, patch: BookingPatch): Promise<Booking | null>;
}

export interface BookingExpectation {
  status: BookingStatus;
  astrologerId?: string;
}

export type BookingPatch = Partial<
  Pick<Booking, "status" | "astrologerId" | "providerId" | "pricePerMinute" | "connectedAt" | "cancelledAt" | "issue" | "startAt" | "endAt">
>;

/** Whether applying `patch` to `b` needs the double-booking check. */
export const needsConflictCheck = (b: Booking, patch: BookingPatch) =>
  (patch.status ?? b.status) === "confirmed" && (b.status !== "confirmed" || (patch.astrologerId !== undefined && patch.astrologerId !== b.astrologerId));

export interface NotificationStore {
  append(n: AstrologerNotification): Promise<void>;
  /** Newest first. */
  listForAstrologer(astrologerId: string, opts: { unreadOnly?: boolean; limit: number }): Promise<AstrologerNotification[]>;
  /** Marks the astrologer's notifications read; returns how many changed. */
  markRead(astrologerId: string, notificationIds: readonly string[], at: number): Promise<number>;
}

const overlaps = (b: Booking, from: number, to: number) => b.startAt < to && from < b.endAt;

export class InMemoryBookingStore implements BookingStore {
  private readonly bookings: Booking[] = [];

  private assertFree(booking: Booking) {
    const clash = this.bookings.find(
      (b) =>
        b.bookingId !== booking.bookingId &&
        b.status === "confirmed" &&
        (b.astrologerId === booking.astrologerId || b.userId === booking.userId) &&
        overlaps(b, booking.startAt, booking.endAt),
    );
    if (clash) {
      throw new SlotUnavailableError(clash.astrologerId === booking.astrologerId ? "astrologer_busy" : "user_busy", booking);
    }
  }

  // No await between the conflict check and the write, so these are atomic.
  async create(booking: Booking) {
    this.assertFree(booking);
    this.bookings.push(booking);
  }

  async get(bookingId: string) {
    const b = this.bookings.find((x) => x.bookingId === bookingId);
    return b ? { ...b } : null;
  }

  async update(bookingId: string, expect: BookingExpectation, patch: BookingPatch) {
    const i = this.bookings.findIndex((x) => x.bookingId === bookingId);
    const b = this.bookings[i];
    if (!b || b.status !== expect.status || (expect.astrologerId !== undefined && b.astrologerId !== expect.astrologerId)) return null;
    const next = { ...b, ...patch };
    if (needsConflictCheck(b, patch)) this.assertFree(next);
    this.bookings[i] = next;
    return { ...next };
  }

  async list(q: BookingQuery) {
    return this.bookings
      .filter(
        (b) =>
          (q.statuses ?? ["confirmed"]).includes(b.status) &&
          (q.astrologerId === undefined || b.astrologerId === q.astrologerId) &&
          (q.userId === undefined || b.userId === q.userId) &&
          overlaps(b, q.from, q.to),
      )
      .sort((a, b) => a.startAt - b.startAt);
  }
}

export class InMemoryNotificationStore implements NotificationStore {
  private readonly notifications: AstrologerNotification[] = [];

  async append(n: AstrologerNotification) {
    this.notifications.push(n);
  }

  async listForAstrologer(astrologerId: string, { unreadOnly = false, limit }: { unreadOnly?: boolean; limit: number }) {
    return this.notifications
      .filter((n) => n.astrologerId === astrologerId && (!unreadOnly || n.readAt === null))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async markRead(astrologerId: string, notificationIds: readonly string[], at: number) {
    const ids = new Set(notificationIds);
    let changed = 0;
    for (const n of this.notifications) {
      if (n.astrologerId === astrologerId && ids.has(n.notificationId) && n.readAt === null) {
        n.readAt = at;
        changed++;
      }
    }
    return changed;
  }
}

const g = globalThis as unknown as { __bookingStore?: BookingStore; __notificationStore?: NotificationStore };

export function getBookingStore(): BookingStore {
  return (g.__bookingStore ??= new InMemoryBookingStore());
}

export function setBookingStore(store: BookingStore): void {
  g.__bookingStore = store;
}

export function getNotificationStore(): NotificationStore {
  return (g.__notificationStore ??= new InMemoryNotificationStore());
}

export function setNotificationStore(store: NotificationStore): void {
  g.__notificationStore = store;
}
