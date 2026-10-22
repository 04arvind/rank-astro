import type { BookingKind } from "@/types/booking";

/*
 * Astrologer portal model: what an astrologer manages themselves
 * (availability, request approvals, notification read state) plus the
 * read-only views the dashboard derives from bookings.
 */

/** Working hours for one weekday, in schedule-local minutes after midnight. */
export interface DayHours {
  enabled: boolean;
  startMinute: number;
  endMinute: number;
}

/** A one-off change for one date: the whole day off, or different hours. */
export type DayOverride = { off: true } | { off: false; startMinute: number; endMinute: number };

/** Time the astrologer blocked out, [startAt, endAt). */
export interface TimeBlock {
  id: string;
  startAt: number;
  endAt: number;
  note?: string;
}

export type PortalStatus = "available" | "unavailable";

export interface PortalSettings {
  astrologerId: string;
  /** The astrologer's own on/off switch. */
  status: PortalStatus;
  /** Index 0 = Sunday … 6 = Saturday. */
  weeklyHours: DayHours[];
  /** Schedule-local date (YYYY-MM-DD) → override. */
  dayOverrides: Record<string, DayOverride>;
  blocks: TimeBlock[];
  /** Scheduled bookings the astrologer has approved. */
  approvedBookingIds: string[];
  /** Notifications created up to then count as read. */
  notificationsSeenAt: number;
  updatedAt: number;
}

/**
 * Where a consultation stands for the astrologer:
 *   pending → confirmed (accepted: scheduled, or a talk-now call to place) → due → live → completed
 *   pending → rejected
 * cancelled (by the user, or reassigned away) and no_show close it otherwise.
 */
export type ConsultationStatus = "pending" | "confirmed" | "due" | "live" | "completed" | "cancelled" | "rejected" | "no_show";

export interface Consultation {
  bookingId: string;
  kind: BookingKind;
  status: ConsultationStatus;
  /** First-Out (duration card, assigned by rotation) or User-Choice (the user picked this astrologer). */
  source: "first_out" | "user_choice";
  user: { id: string; name: string | null; city: string | null; mobile: string | null };
  topic: string | null;
  language: string | null;
  /** What happened, e.g. why a request was rejected. */
  note: string | null;
  /** When the user booked. */
  requestedAt: number;
  /** Call start (talk now: when it was requested). */
  startAt: number;
  endAt: number;
  /** Talk now: call the user by then. */
  pickupBy: number | null;
  durationMinutes: number;
  pricePerMinute: number;
  /** What the user pays (INR): the amount paid when they paid up front, else price × duration. */
  amount: number;
  /** Set when the user paid before booking (First-Out). */
  paid: { paymentId: string; amount: number } | null;
  /** The astrologer's share when the provider shares payout rates, else null. */
  payout: number | null;
  connectedAt: number | null;
  cancelledAt: number | null;
  /** Accept / reject are offered (still pending). */
  canAccept: boolean;
  canReject: boolean;
  /** Call now is offered (a talk-now call to place, or an accepted call about to start). */
  canCall: boolean;
}

export type NotificationKind = "new_booking" | "cancellation" | "schedule_change";

export interface PortalNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  message: string;
  bookingId: string;
  createdAt: number;
  read: boolean;
}

export interface EarningsSummary {
  /** Sum of completed consultation amounts (INR). */
  total: number;
  /** Sum of payouts, when the provider shares payout rates. */
  payout: number | null;
  completedCalls: number;
  averagePerCall: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  /** Completed consultations, newest first. */
  items: Consultation[];
}

export interface CalendarEvent {
  bookingId: string;
  startAt: number;
  endAt: number;
  status: ConsultationStatus;
  userName: string;
}
