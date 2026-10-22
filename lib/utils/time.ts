export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Elapsed time between two epoch-ms instants in the given unit (never negative). */
export function elapsed(from: number, to: number, unitMs: number): number {
  return Math.max(0, to - from) / unitMs;
}

export const daysSince = (t: number, now = Date.now()) => elapsed(t, now, DAY_MS);
export const hoursSince = (t: number, now = Date.now()) => elapsed(t, now, HOUR_MS);

export interface TimeRange {
  from: number;
  to: number;
}

/** The range ending at `now` and spanning `durationMs`. */
export function lastPeriod(durationMs: number, now = Date.now()): TimeRange {
  return { from: now - durationMs, to: now };
}

/** Overlap of [start, end] with the range, in ms. */
export function overlapMs(start: number, end: number, range: TimeRange): number {
  return Math.max(0, Math.min(end, range.to) - Math.max(start, range.from));
}
