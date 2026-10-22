import type { BookingConfig } from "@/config";
import { DAY_MS, MINUTE_MS } from "@/lib/utils/time";
import type { Booking, ScheduleDay, SlotStatus } from "@/types/booking";
import { localDate, localDayStart, localMinuteOfDay } from "./time";

type SlotRules = Pick<
  BookingConfig,
  "slotMinutes" | "horizonDays" | "minLeadMinutes" | "utcOffsetMinutes" | "workingHours"
>;

type Busy = Pick<Booking, "astrologerId" | "userId" | "startAt" | "endAt">;

const overlaps = (start: number, end: number, b: Busy) => start < b.endAt && b.startAt < end;

/** First and last instant of the bookable window, [from, to). */
export function bookingWindow(rules: SlotRules, now: number): { from: number; to: number } {
  const today = localDayStart(now, rules.utcOffsetMinutes);
  return { from: now + rules.minLeadMinutes * MINUTE_MS, to: today + rules.horizonDays * DAY_MS };
}

/**
 * Whether `startAt` is the start of a slot the calendar would offer: on the
 * slot grid, inside working hours, far enough ahead and within the horizon.
 * Busy-ness is checked separately against stored bookings.
 */
export function isOnSchedule(startAt: number, rules: SlotRules, now: number): boolean {
  const { from, to } = bookingWindow(rules, now);
  if (startAt < from || startAt >= to) return false;
  const minute = localMinuteOfDay(startAt, rules.utcOffsetMinutes);
  const { startMinute, endMinute } = rules.workingHours;
  return (
    Number.isInteger(minute) &&
    minute % rules.slotMinutes === 0 &&
    minute >= startMinute &&
    minute + rules.slotMinutes <= endMinute
  );
}

/**
 * The calendar one user sees for one astrologer: every slot of every day in
 * the horizon, marked with what stops it being bookable. `astrologerBookings`
 * are the astrologer's confirmed bookings; `userBookings` are the user's
 * confirmed bookings with anyone.
 */
export function buildSchedule(
  {
    astrologerId,
    userId,
    astrologerBookings,
    userBookings,
  }: { astrologerId: string; userId?: string; astrologerBookings: readonly Busy[]; userBookings: readonly Busy[] },
  rules: SlotRules,
  now: number,
): ScheduleDay[] {
  const slotMs = rules.slotMinutes * MINUTE_MS;
  const { from } = bookingWindow(rules, now);
  const today = localDayStart(now, rules.utcOffsetMinutes);
  const { startMinute, endMinute } = rules.workingHours;

  const statusOf = (start: number, end: number): SlotStatus => {
    if (start < from) return "unavailable";
    const astrologerBusy = astrologerBookings.filter((b) => overlaps(start, end, b));
    if (userId && astrologerBusy.some((b) => b.userId === userId)) return "yours";
    if (astrologerBusy.length > 0) return "unavailable";
    if (userBookings.some((b) => b.astrologerId !== astrologerId && overlaps(start, end, b))) return "userBusy";
    return "available";
  };

  return Array.from({ length: rules.horizonDays }, (_, d) => {
    const dayStart = today + d * DAY_MS;
    const slots = [];
    for (let m = startMinute; m + rules.slotMinutes <= endMinute; m += rules.slotMinutes) {
      const startAt = dayStart + m * MINUTE_MS;
      slots.push({ startAt, endAt: startAt + slotMs, status: statusOf(startAt, startAt + slotMs) });
    }
    return { date: localDate(dayStart, rules.utcOffsetMinutes), slots };
  });
}
