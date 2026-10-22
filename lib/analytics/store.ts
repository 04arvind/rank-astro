import { config } from "@/config";
import type { AnalyticsEvent, AnalyticsEventType, TimeRange } from "@/types/analytics";

export type EventOf<T extends AnalyticsEventType> = Extract<AnalyticsEvent, { type: T }>;

export interface EventQuery<T extends AnalyticsEventType> {
  type: T;
  range: TimeRange;
  astrologerIds?: readonly string[];
  providerIds?: readonly string[];
  userId?: string;
  sessionId?: string;
}

/**
 * Persistence boundary for analytics events. The in-memory store below is
 * for development; a MongoDB/warehouse implementation plugs in via
 * setAnalyticsStore() without changing any aggregation code.
 */
export interface AnalyticsStore {
  append(events: readonly AnalyticsEvent[]): Promise<void>;
  query<T extends AnalyticsEventType>(q: EventQuery<T>): Promise<EventOf<T>[]>;
}

export class InMemoryAnalyticsStore implements AnalyticsStore {
  private readonly byType = new Map<AnalyticsEventType, AnalyticsEvent[]>();

  constructor(private readonly maxPerType = config.analytics.store.maxEventsPerType) {}

  async append(events: readonly AnalyticsEvent[]): Promise<void> {
    for (const event of events) {
      const list = this.byType.get(event.type) ?? [];
      list.push(event);
      if (list.length > this.maxPerType) list.splice(0, list.length - this.maxPerType);
      this.byType.set(event.type, list);
    }
  }

  async query<T extends AnalyticsEventType>(q: EventQuery<T>): Promise<EventOf<T>[]> {
    const astrologers = q.astrologerIds && new Set(q.astrologerIds);
    const providers = q.providerIds && new Set(q.providerIds);
    const list = (this.byType.get(q.type) ?? []) as EventOf<T>[];

    return list.filter(
      (e) =>
        e.timestamp >= q.range.from &&
        e.timestamp <= q.range.to &&
        (!astrologers || astrologers.has(e.astrologerId)) &&
        (!providers || providers.has(e.providerId)) &&
        (!q.userId || e.userId === q.userId) &&
        (!q.sessionId || e.sessionId === q.sessionId),
    );
  }
}

// Keep one store across dev hot reloads.
const globalStore = globalThis as unknown as { __analyticsStore?: AnalyticsStore };

export function getAnalyticsStore(): AnalyticsStore {
  return (globalStore.__analyticsStore ??= new InMemoryAnalyticsStore());
}

export function setAnalyticsStore(store: AnalyticsStore): void {
  globalStore.__analyticsStore = store;
}
