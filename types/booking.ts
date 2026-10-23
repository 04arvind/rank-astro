import type { ConsultationMode } from "./astrologer";

export type BookingStatus = "confirmed" | "cancelled" | "expired";

/**
 * "scheduled": a future slot. "instant" (talk now): the astrologer calls
 * within the pickup window; the booking holds them from booking time
 * until the window plus the call length has passed.
 */
export type BookingKind = "instant" | "scheduled";

/** Why a confirmed booking needs the user's attention. */
export type BookingIssue = "astrologer_unavailable";

/**
 * One booking = one call = one assigned astrologer. Times are epoch ms,
 * [startAt, endAt); a confirmed booking locks the astrologer (and the user)
 * for that range.
 */
export interface Booking {
  bookingId: string;
  astrologerId: string;
  providerId: string;
  userId: string;
  sessionId?: string;
  mode: ConsultationMode;
  startAt: number;
  endAt: number;
  durationMinutes: number;
  /** Price at booking time; the call itself is still billed per second. */
  pricePerMinute: number;
  status: BookingStatus;
  createdAt: number;
  /** Absent on bookings made before instant calls existed: scheduled. */
  kind?: BookingKind;
  /** Consultation length the user chose (a DURATIONS value), when booked from a duration card; picks the reassignment pool. */
  minutes?: number;
  /** Duration card only: the topic and language the user picked; every First-Out (re)assignment is limited to astrologers matching them. */
  preferences?: { topic: string | null; language: string | null };
  /** Instant only: the astrologer must call by then. */
  pickupBy?: number;
  /** When the astrologer connected the call (reported by the provider integration). */
  connectedAt?: number | null;
  cancelledAt?: number;
  issue?: BookingIssue | null;
}

/**
 * What the user sees of their booking; the assigned astrologer isn't
 * revealed. "missed": an instant call nobody picked up in time.
 */
export interface BookingView {
  bookingId: string;
  mode: BookingKind;
  state: "upcoming" | "awaiting_call" | "connected" | "missed" | "cancelled";
  startAt: number;
  endAt: number;
  pickupBy: number | null;
  minutes: number | null;
  /** "Wed, 1 Oct · 4:30 PM IST" */
  label: string;
  issue: BookingIssue | null;
}

/** Whether a "talk now" call can be placed right now, for a pooled schedule. */
export interface InstantAvailability {
  available: boolean;
  pickupMinutes: number;
}

/**
 * Why a slot shows as it does, from the requesting user's point of view.
 * "unavailable" covers past, too-soon and astrologer-busy slots alike, so
 * other users' bookings aren't revealed.
 */
export type SlotStatus = "available" | "unavailable" | "userBusy" | "yours";

export interface Slot {
  startAt: number;
  endAt: number;
  status: SlotStatus;
}

export interface ScheduleDay {
  /** Schedule-local date, YYYY-MM-DD. */
  date: string;
  slots: Slot[];
}

export interface Schedule {
  /** The astrologer, or "pool:<minutes>" for a duration card's pooled calendar. */
  astrologerId: string;
  slotMinutes: number;
  utcOffsetMinutes: number;
  timeZoneLabel: string;
  days: ScheduleDay[];
  /** Pooled schedules only. */
  instant?: InstantAvailability;
}

export type NotificationDelivery = "inbox" | "sent" | "failed";

/** A message for an astrologer (today: a new booking), kept in their inbox. */
export interface AstrologerNotification {
  notificationId: string;
  astrologerId: string;
  providerId: string;
  type: "booking.scheduled";
  bookingId: string;
  scheduledStartAt: number;
  scheduledEndAt: number;
  title: string;
  message: string;
  createdAt: number;
  readAt: number | null;
  /** "inbox" when the provider has no push hook; otherwise the push outcome. */
  delivery: NotificationDelivery;
}
