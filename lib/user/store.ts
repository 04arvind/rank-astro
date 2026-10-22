import type { FavoriteAstrologer, UserPreferences, UserProfile } from "@/types/user";

/**
 * Persistence boundary for user data. Call history is not stored here —
 * it comes from lib/analytics. Swap the in-memory store for a DB-backed one
 * with setUserStore().
 */
export interface UserStore {
  getProfile(userId: string): Promise<UserProfile | undefined>;
  saveProfile(profile: UserProfile): Promise<void>;
  getPreferences(userId: string): Promise<UserPreferences | undefined>;
  savePreferences(prefs: UserPreferences): Promise<void>;
  getFavorites(userId: string): Promise<FavoriteAstrologer[]>;
  saveFavorites(userId: string, favorites: FavoriteAstrologer[]): Promise<void>;
}

export class InMemoryUserStore implements UserStore {
  private readonly profiles = new Map<string, UserProfile>();
  private readonly preferences = new Map<string, UserPreferences>();
  private readonly favorites = new Map<string, FavoriteAstrologer[]>();

  async getProfile(userId: string) {
    return this.profiles.get(userId);
  }
  async saveProfile(profile: UserProfile) {
    this.profiles.set(profile.userId, profile);
  }
  async getPreferences(userId: string) {
    return this.preferences.get(userId);
  }
  async savePreferences(prefs: UserPreferences) {
    this.preferences.set(prefs.userId, prefs);
  }
  async getFavorites(userId: string) {
    return this.favorites.get(userId) ?? [];
  }
  async saveFavorites(userId: string, favorites: FavoriteAstrologer[]) {
    this.favorites.set(userId, favorites);
  }
}

const g = globalThis as unknown as { __userStore?: UserStore };

export function getUserStore(): UserStore {
  return (g.__userStore ??= new InMemoryUserStore());
}

export function setUserStore(store: UserStore): void {
  g.__userStore = store;
}
