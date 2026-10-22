import { DatabaseError } from "@/lib/errors";
import type { UserStore } from "@/lib/user/store";
import type { FavoriteAstrologer, UserPreferences, UserProfile } from "@/types/user";
import { getCollections, stripId, type Collections } from "./collections";

async function run<T>(operation: string, collection: string, fn: (c: Collections) => Promise<T>): Promise<T> {
  const c = await getCollections();
  try {
    return await fn(c);
  } catch (err) {
    throw new DatabaseError(`User store ${operation} failed`, { operation, collection }, { cause: err });
  }
}

/** User profiles, preferences and favourites, one document per user in each collection. */
export class MongoUserStore implements UserStore {
  async getProfile(userId: string): Promise<UserProfile | undefined> {
    const doc = await run("getProfile", "user_profiles", (c) => c.userProfiles.findOne({ _id: userId }));
    return doc ? stripId(doc) : undefined;
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    await run("saveProfile", "user_profiles", (c) =>
      c.userProfiles.replaceOne({ _id: profile.userId }, { ...profile }, { upsert: true }),
    );
  }

  async getPreferences(userId: string): Promise<UserPreferences | undefined> {
    const doc = await run("getPreferences", "user_preferences", (c) => c.userPreferences.findOne({ _id: userId }));
    return doc ? stripId(doc) : undefined;
  }

  async savePreferences(prefs: UserPreferences): Promise<void> {
    await run("savePreferences", "user_preferences", (c) =>
      c.userPreferences.replaceOne({ _id: prefs.userId }, { ...prefs }, { upsert: true }),
    );
  }

  async getFavorites(userId: string): Promise<FavoriteAstrologer[]> {
    const doc = await run("getFavorites", "user_favorites", (c) => c.userFavorites.findOne({ _id: userId }));
    return doc?.favorites ?? [];
  }

  async saveFavorites(userId: string, favorites: FavoriteAstrologer[]): Promise<void> {
    await run("saveFavorites", "user_favorites", (c) =>
      c.userFavorites.replaceOne({ _id: userId }, { favorites, updatedAt: Date.now() }, { upsert: true }),
    );
  }
}
