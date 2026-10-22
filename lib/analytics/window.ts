import { DAY_MS, HOUR_MS, lastPeriod, type TimeRange } from "@/lib/utils/time";
import type { StatsWindow } from "@/types/ranking";

const WINDOW_MS: Record<StatsWindow, number> = {
  "1h": HOUR_MS,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

export function toRange(window: StatsWindow | TimeRange, now = Date.now()): TimeRange {
  return typeof window === "string" ? lastPeriod(WINDOW_MS[window], now) : window;
}
