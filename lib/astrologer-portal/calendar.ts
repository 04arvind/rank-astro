import { localDate, localDayStart } from "@/lib/booking/time";
import { DAY_MS, MINUTE_MS } from "@/lib/utils/time";
import type { CalendarEvent, DayHours, PortalSettings, TimeBlock } from "./types";

/*
 * Calendar math for the astrologer portal. Pure and dependency-free, so the
 * calendar component runs it in the browser as well. Days are
 * schedule-local (fixed UTC offset), like the booking calendar.
 */

export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Epoch ms of local midnight for a YYYY-MM-DD date. */
export function dayStartOf(date: string, offsetMinutes: number): number {
  return Date.parse(`${date}T00:00:00Z`) - offsetMinutes * MINUTE_MS;
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export const todayKey = (now: number, offsetMinutes: number) => localDate(now, offsetMinutes);

/** Monday starting the week that contains `date`. */
export function weekStart(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** The 6×7 grid (Monday first) covering the month that contains `date`. */
export function monthGrid(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const start = weekStart(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Working hours on a date after its override, or null when the day is off. */
export function hoursOn(settings: Pick<PortalSettings, "weeklyHours" | "dayOverrides">, date: string): { startMinute: number; endMinute: number } | null {
  const o = settings.dayOverrides[date];
  if (o) return o.off ? null : { startMinute: o.startMinute, endMinute: o.endMinute };
  const w: DayHours | undefined = settings.weeklyHours[weekdayOf(date)];
  return w?.enabled && w.endMinute > w.startMinute ? { startMinute: w.startMinute, endMinute: w.endMinute } : null;
}

export type SlotState = "open" | "booked" | "blocked" | "off" | "past";

export interface DaySlot {
  startAt: number;
  endAt: number;
  state: SlotState;
  event?: CalendarEvent;
  block?: TimeBlock;
}

const overlaps = (s: number, e: number, x: { startAt: number; endAt: number }) => s < x.endAt && x.startAt < e;

/**
 * One date's slots over the union of the standard day (`gridStart`–`gridEnd`)
 * and the day's own hours, each marked: booked beats blocked beats off.
 */
export function daySlots(
  date: string,
  settings: Pick<PortalSettings, "weeklyHours" | "dayOverrides" | "blocks">,
  events: readonly CalendarEvent[],
  opts: { offsetMinutes: number; slotMinutes: number; gridStart: number; gridEnd: number; now: number },
): DaySlot[] {
  const hours = hoursOn(settings, date);
  const from = Math.min(opts.gridStart, hours?.startMinute ?? opts.gridStart);
  const to = Math.max(opts.gridEnd, hours?.endMinute ?? opts.gridEnd);
  const day = dayStartOf(date, opts.offsetMinutes);
  const slots: DaySlot[] = [];
  for (let m = from; m + opts.slotMinutes <= to; m += opts.slotMinutes) {
    const startAt = day + m * MINUTE_MS;
    const endAt = startAt + opts.slotMinutes * MINUTE_MS;
    const event = events.find((e) => e.status !== "cancelled" && overlaps(startAt, endAt, e));
    const block = settings.blocks.find((b) => overlaps(startAt, endAt, b));
    const inHours = hours !== null && m >= hours.startMinute && m + opts.slotMinutes <= hours.endMinute;
    const state: SlotState = event ? "booked" : block ? "blocked" : !inHours ? "off" : endAt <= opts.now ? "past" : "open";
    slots.push({ startAt, endAt, state, event, block });
  }
  return slots;
}

/** Whether the day containing `t` is `date`. */
export const isOnDate = (t: number, date: string, offsetMinutes: number) => localDate(localDayStart(t, offsetMinutes), offsetMinutes) === date;

/** "10:00" ↔ minutes after midnight, for time inputs. */
export const minutesToInput = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export function inputToMinutes(v: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!match) return null;
  const m = Number(match[1]) * 60 + Number(match[2]);
  return m >= 0 && m <= 24 * 60 ? m : null;
}
