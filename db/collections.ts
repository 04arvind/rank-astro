import type { Collection, Db } from "mongodb";
import type { AnalyticsEvent } from "@/types/analytics";
import type { AstrologerProfile } from "@/types/astrologer";
import type { AstrologerNotification, Booking } from "@/types/booking";
import type { FavoriteAstrologer, UserPreferences, UserProfile } from "@/types/user";
import { getDb } from "./client";

/*
 * Collection names, document shapes and indexes. Every document's _id is
 * the domain id (astrologer id, eventId, userId), so writes are idempotent
 * upserts and reads never need a second key.
 */

export const COLLECTIONS = {
  astrologers: "astrologers",
  events: "analytics_events",
  userProfiles: "user_profiles",
  userPreferences: "user_preferences",
  userFavorites: "user_favorites",
  bookings: "bookings",
  notifications: "astrologer_notifications",
} as const;

export type AstrologerDoc = AstrologerProfile & { _id: string; syncedAt: number };
export type EventDoc = AnalyticsEvent & { _id: string };
export type UserProfileDoc = UserProfile & { _id: string };
export type UserPreferencesDoc = UserPreferences & { _id: string };
export type BookingDoc = Booking & { _id: string };
export type NotificationDoc = AstrologerNotification & { _id: string };
export interface UserFavoritesDoc {
  _id: string;
  favorites: FavoriteAstrologer[];
  updatedAt: number;
}

export interface Collections {
  astrologers: Collection<AstrologerDoc>;
  events: Collection<EventDoc>;
  userProfiles: Collection<UserProfileDoc>;
  userPreferences: Collection<UserPreferencesDoc>;
  userFavorites: Collection<UserFavoritesDoc>;
  bookings: Collection<BookingDoc>;
  notifications: Collection<NotificationDoc>;
}

function collectionsOf(db: Db): Collections {
  return {
    astrologers: db.collection<AstrologerDoc>(COLLECTIONS.astrologers),
    events: db.collection<EventDoc>(COLLECTIONS.events),
    userProfiles: db.collection<UserProfileDoc>(COLLECTIONS.userProfiles),
    userPreferences: db.collection<UserPreferencesDoc>(COLLECTIONS.userPreferences),
    userFavorites: db.collection<UserFavoritesDoc>(COLLECTIONS.userFavorites),
    bookings: db.collection<BookingDoc>(COLLECTIONS.bookings),
    notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
  };
}

export async function getCollections(): Promise<Collections> {
  return collectionsOf(await getDb());
}

/**
 * Indexes matching the query shapes in lib/analytics (type + time range,
 * optionally narrowed by astrologer, provider, user or session). Booking
 * indexes are unique per slot start among confirmed bookings, which is what
 * makes a double booking impossible even under concurrent requests. Safe to
 * run repeatedly; MongoDB skips indexes that already exist.
 */
export async function ensureIndexes(): Promise<void> {
  const c = await getCollections();
  await Promise.all([
    c.astrologers.createIndex({ providerId: 1 }),
    c.events.createIndexes([
      { key: { type: 1, timestamp: 1 } },
      { key: { type: 1, astrologerId: 1, timestamp: 1 } },
      { key: { type: 1, providerId: 1, timestamp: 1 } },
      { key: { type: 1, userId: 1, timestamp: 1 }, sparse: true },
      { key: { type: 1, sessionId: 1, timestamp: 1 }, sparse: true },
    ]),
    c.bookings.createIndexes([
      { key: { astrologerId: 1, startAt: 1 }, unique: true, partialFilterExpression: { status: "confirmed" } },
      { key: { userId: 1, startAt: 1 }, unique: true, partialFilterExpression: { status: "confirmed" } },
    ]),
    c.notifications.createIndex({ astrologerId: 1, createdAt: -1 }),
  ]);
}

/** Drops Mongo's _id (and sync bookkeeping) to get the domain object back. */
export function stripId<T extends { _id: unknown }>(doc: T): Omit<T, "_id"> {
  const { _id, ...rest } = doc;
  void _id;
  return rest;
}
