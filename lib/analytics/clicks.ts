import type { ClickEvent } from "@/types/analytics";
import { countBy } from "@/lib/utils/collections";
import { clickInput, parseInput, withMeta, type ClickInput } from "./ingest";
import { getAnalyticsStore } from "./store";

export async function recordClicks(inputs: readonly ClickInput[]): Promise<ClickEvent[]> {
  const now = Date.now();
  const events = inputs.map(
    (input): ClickEvent => ({ type: "click", ...withMeta(parseInput(clickInput, input), now) }),
  );
  await getAnalyticsStore().append(events);
  return events;
}

export const clicksByAstrologer = (events: readonly ClickEvent[]) =>
  countBy(events, (e) => e.astrologerId);

export const clicksByProvider = (events: readonly ClickEvent[]) =>
  countBy(events, (e) => e.providerId);
