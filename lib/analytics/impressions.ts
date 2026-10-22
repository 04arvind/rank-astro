import type { ImpressionEvent } from "@/types/analytics";
import { countBy } from "@/lib/utils/collections";
import { impressionInput, parseInput, withMeta, type ImpressionInput } from "./ingest";
import { getAnalyticsStore } from "./store";

export async function recordImpressions(inputs: readonly ImpressionInput[]): Promise<ImpressionEvent[]> {
  const now = Date.now();
  const events = inputs.map(
    (input): ImpressionEvent => ({
      type: "impression",
      ...withMeta(parseInput(impressionInput, input), now),
    }),
  );
  await getAnalyticsStore().append(events);
  return events;
}

export const impressionsByAstrologer = (events: readonly ImpressionEvent[]) =>
  countBy(events, (e) => e.astrologerId);

export const impressionsByProvider = (events: readonly ImpressionEvent[]) =>
  countBy(events, (e) => e.providerId);

/** Impressions per provider limited to positions 1..topN. */
export const topNImpressionsByProvider = (events: readonly ImpressionEvent[], topN: number) =>
  impressionsByProvider(events.filter((e) => e.position <= topN));

/** Impressions per position — for position-bias analysis. */
export const impressionsByPosition = (events: readonly ImpressionEvent[]) =>
  countBy(events, (e) => String(e.position));
