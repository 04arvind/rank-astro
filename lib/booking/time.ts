import { DAY_MS, MINUTE_MS } from "@/lib/utils/time";

/*
 * Schedule-local time helpers. The schedule runs on a fixed UTC offset
 * (config.booking.utcOffsetMinutes), so local time is just a shifted UTC
 * clock — no time-zone database needed. Pure and dependency-free so the
 * slot picker can use them in the browser too.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const local = (t: number, offsetMinutes: number) => new Date(t + offsetMinutes * MINUTE_MS);

/** Epoch ms of the schedule-local midnight starting the day that contains `t`. */
export function localDayStart(t: number, offsetMinutes: number): number {
  const shift = offsetMinutes * MINUTE_MS;
  return Math.floor((t + shift) / DAY_MS) * DAY_MS - shift;
}

/** Minutes after schedule-local midnight. */
export function localMinuteOfDay(t: number, offsetMinutes: number): number {
  return (t - localDayStart(t, offsetMinutes)) / MINUTE_MS;
}

/** Schedule-local date as YYYY-MM-DD. */
export function localDate(t: number, offsetMinutes: number): string {
  return local(t, offsetMinutes).toISOString().slice(0, 10);
}

/** "4:30 PM" */
export function formatTime(t: number, offsetMinutes: number): string {
  const d = local(t, offsetMinutes);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "Wed, 1 Oct" */
export function formatDay(t: number, offsetMinutes: number): string {
  const d = local(t, offsetMinutes);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Wed, 1 Oct · 4:30 PM IST" */
export function formatSlot(t: number, offsetMinutes: number, zoneLabel: string): string {
  return `${formatDay(t, offsetMinutes)} · ${formatTime(t, offsetMinutes)} ${zoneLabel}`;
}
