import { MongoBulkWriteError, type Filter } from "mongodb";
import type { AnalyticsStore, EventOf, EventQuery } from "@/lib/analytics/store";
import { DatabaseError } from "@/lib/errors";
import type { AnalyticsEvent, AnalyticsEventType } from "@/types/analytics";
import { getCollections, stripId, type EventDoc } from "./collections";

const DUPLICATE_KEY = 11000;

/**
 * Analytics events in the `analytics_events` collection, keyed by eventId,
 * so a retried batch is a no-op instead of double-counting.
 */
export class MongoAnalyticsStore implements AnalyticsStore {
  async append(events: readonly AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) return;
    const { events: col } = await getCollections();
    try {
      await col.insertMany(
        events.map((e) => ({ ...e, _id: e.eventId }) as EventDoc),
        { ordered: false },
      );
    } catch (err) {
      const onlyDuplicates =
        err instanceof MongoBulkWriteError &&
        (Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors]).every((w) => w.code === DUPLICATE_KEY);
      if (onlyDuplicates) return;
      throw new DatabaseError("Failed to append analytics events", { operation: "insertMany", collection: "analytics_events" }, { cause: err });
    }
  }

  async query<T extends AnalyticsEventType>(q: EventQuery<T>): Promise<EventOf<T>[]> {
    const filter: Record<string, unknown> = { type: q.type, timestamp: { $gte: q.range.from, $lte: q.range.to } };
    if (q.astrologerIds) filter.astrologerId = { $in: [...q.astrologerIds] };
    if (q.providerIds) filter.providerId = { $in: [...q.providerIds] };
    if (q.userId) filter.userId = q.userId;
    if (q.sessionId) filter.sessionId = q.sessionId;

    const { events: col } = await getCollections();
    try {
      const docs = await col.find(filter as Filter<EventDoc>).sort({ timestamp: 1 }).toArray();
      return docs.map((d) => stripId(d) as EventOf<T>);
    } catch (err) {
      throw new DatabaseError("Failed to query analytics events", { operation: "find", collection: "analytics_events" }, { cause: err });
    }
  }
}
