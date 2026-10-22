import { setAnalyticsStore } from "@/lib/analytics";
import { normalizeFeeds, setAstrologerRepository, type RejectedRecord } from "@/lib/astrologer";
import { setBookingStore, setNotificationStore } from "@/lib/booking";
import { logError } from "@/lib/errors";
import { listProviders, loadProviderRecords } from "@/lib/providers";
import { setBanditStore } from "@/lib/ranking/bandit/store";
import { setTrainingLogStore } from "@/lib/ranking/ml/trainingLog";
import { setUserStore } from "@/lib/user";
import { MongoAnalyticsStore } from "./analyticsStore";
import { countAstrologers, MongoAstrologerRepository, syncAstrologers, type SyncResult } from "./astrologerRepository";
import { MongoBanditStore } from "./banditStore";
import { MongoBookingStore, MongoNotificationStore } from "./bookingStore";
import { databaseName, isDatabaseConfigured } from "./client";
import { ensureIndexes } from "./collections";
import { MongoTrainingLogStore } from "./trainingStore";
import { MongoUserStore } from "./userStore";

/*
 * MongoDB persistence. Each class implements an existing boundary
 * (AstrologerRepository, AnalyticsStore, UserStore, BookingStore,
 * NotificationStore), so ranking, analytics, booking
 * and the API don't know which backend is active.
 */

export { closeDb, getDb, isDatabaseConfigured } from "./client";
export { COLLECTIONS, ensureIndexes, getCollections } from "./collections";
export { MongoAstrologerRepository, syncAstrologers, countAstrologers, type SyncResult } from "./astrologerRepository";
export { MongoAnalyticsStore } from "./analyticsStore";
export { MongoUserStore } from "./userStore";
export { MongoBookingStore, MongoNotificationStore } from "./bookingStore";
export { MongoBanditStore } from "./banditStore";
export { MongoTrainingLogStore } from "./trainingStore";

export interface FeedSyncResult extends SyncResult {
  /** Accepted astrologers per provider. */
  byProvider: Record<string, number>;
  rejected: RejectedRecord[];
  /** Providers whose feed could not be read; their astrologers were left untouched. */
  failed: { providerId: string; message: string }[];
}

/** Reads every enabled provider feed (data/csv/*), normalizes it and syncs it into MongoDB. */
export async function syncAstrologersFromFeeds(): Promise<FeedSyncResult> {
  const feeds: Record<string, unknown[]> = {};
  const failed: FeedSyncResult["failed"] = [];
  for (const p of listProviders({ enabledOnly: true })) {
    try {
      feeds[p.id] = await loadProviderRecords(p.id);
    } catch (err) {
      logError(err, { scope: "db", operation: "syncFeeds", providerId: p.id });
      failed.push({ providerId: p.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const { astrologers, rejected } = normalizeFeeds(feeds);
  const result = await syncAstrologers(astrologers, Object.keys(feeds));
  const byProvider: Record<string, number> = {};
  for (const a of astrologers) byProvider[a.providerId] = (byProvider[a.providerId] ?? 0) + 1;
  return { ...result, byProvider, rejected, failed };
}

const g = globalThis as unknown as { __dbInstalled?: boolean };

/**
 * Switches the app onto MongoDB: ensures indexes, seeds astrologers from the
 * feeds when the collection is empty, and installs the Mongo-backed
 * repository and stores. Without MONGO_URI, or if MongoDB is unreachable,
 * logs why and leaves the in-memory/feed defaults in place.
 */
export async function installDatabase(): Promise<boolean> {
  if (g.__dbInstalled) return true;
  if (!isDatabaseConfigured()) {
    console.warn("[db] MONGO_URI not set; using in-memory stores and the provider feeds");
    return false;
  }

  try {
    await ensureIndexes();
    if ((await countAstrologers()) === 0) {
      const seeded = await syncAstrologersFromFeeds();
      console.log(`[db] seeded ${seeded.upserted} astrologers from provider feeds`, seeded.byProvider);
    }
  } catch (err) {
    logError(err, { scope: "db", operation: "install" });
    console.warn("[db] MongoDB unavailable; using in-memory stores and the provider feeds");
    return false;
  }

  setAstrologerRepository(new MongoAstrologerRepository());
  setAnalyticsStore(new MongoAnalyticsStore());
  setUserStore(new MongoUserStore());
  setBookingStore(new MongoBookingStore());
  setNotificationStore(new MongoNotificationStore());
  setBanditStore(new MongoBanditStore());
  setTrainingLogStore(new MongoTrainingLogStore());
  g.__dbInstalled = true;
  console.log(`[db] connected to MongoDB database "${databaseName()}"`);
  return true;
}
