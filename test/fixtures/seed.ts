import { InMemoryAnalyticsStore, recordCall, recordClicks, recordImpressions, recordRating, setAnalyticsStore } from "@/lib/analytics";
import { InMemoryAstrologerRepository, setAstrologerRepository } from "@/lib/astrologer";
import { resetProviderStates } from "@/lib/ranking";
import { addFavorite, InMemoryUserStore, setUserPreferences, setUserStore, upsertUserProfile } from "@/lib/user";
import type { AstrologerProfile } from "@/types/astrologer";
import { ALL_ASTROLOGERS } from "./astrologers";
import { BASE_HISTORY, mergeHistory, USER_HISTORY, type HistorySet } from "./history";
import { TRAFFIC, type TrafficPreset } from "./providers";
import type { RankingScenario } from "./scenarios";
import { NOW } from "./time";
import { USERS, type UserFixture, type UserKey } from "./user";

/*
 * Installs fixtures into fresh in-memory stores through the public lib/
 * APIs. Setup only — no ranking logic. Call before each test for isolation.
 */

export interface SeedOptions {
  astrologers?: readonly AstrologerProfile[];
  users?: readonly UserKey[];
  history?: HistorySet;
  traffic?: TrafficPreset;
}

export async function seed({ astrologers = ALL_ASTROLOGERS, users = [], history = BASE_HISTORY, traffic }: SeedOptions = {}): Promise<void> {
  // Never reach a real provider API from fixtures.
  delete process.env.PROVIDER_C_API_URL;

  setAstrologerRepository(new InMemoryAstrologerRepository(astrologers));
  setAnalyticsStore(new InMemoryAnalyticsStore());
  setUserStore(new InMemoryUserStore());
  resetProviderStates();

  const own = users.map((u) => USER_HISTORY[u]).filter((h): h is HistorySet => h !== undefined);
  const t = traffic ? TRAFFIC[traffic] : undefined;
  const all = mergeHistory(history, ...own, { impressions: t?.impressions ?? [], clicks: [], calls: t?.calls ?? [], ratings: [] });

  await recordImpressions(all.impressions);
  await recordClicks(all.clicks);
  for (const c of all.calls) await recordCall(c);
  for (const r of all.ratings) await recordRating(r);

  for (const key of users) await seedUser(USERS[key]);
}

async function seedUser(u: UserFixture): Promise<void> {
  if (!u.userId) return;
  if (u.profile) await upsertUserProfile(u.profile);
  if (u.preferences) await setUserPreferences(u.userId, u.preferences);
  // Oldest first so the list ends up most-recent-first.
  for (const [i, id] of [...(u.favorites ?? [])].reverse().entries()) await addFavorite(u.userId, id, NOW - (i + 1) * 1000);
}

/** Seeds everything a scenario needs. Pass `now: NOW` to the engine afterwards. */
export function seedScenario(s: RankingScenario): Promise<void> {
  return seed({ users: [s.user], history: s.history ?? BASE_HISTORY, traffic: s.traffic });
}
