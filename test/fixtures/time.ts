import { DAY_MS, HOUR_MS, MINUTE_MS } from "@/lib/utils/time";

/**
 * The fixed "current time" for every fixture and test. Pass it as `now` to
 * the engine so results never depend on the wall clock.
 */
export const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z

export const minutesAgo = (n: number) => NOW - n * MINUTE_MS;
export const hoursAgo = (n: number) => NOW - n * HOUR_MS;
export const daysAgo = (n: number) => NOW - n * DAY_MS;
