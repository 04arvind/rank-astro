import { z } from "zod";
import { ValidationError } from "@/lib/errors";
import { parseOrThrow } from "@/lib/utils/validation";
import type { UserProfile } from "@/types/user";
import { getUserStore } from "./store";

const profileInput = z.object({
  userId: z.string().trim().min(1).max(128),
  displayName: z.string().trim().max(80).optional(),
  createdAt: z.number().int().nonnegative().optional(),
  platform: z.enum(["web", "android", "ios"]).optional(),
});

export type UserProfileInput = z.input<typeof profileInput>;

export async function getUserProfile(userId: string): Promise<UserProfile | undefined> {
  return getUserStore().getProfile(userId);
}

/** Creates or updates a profile; createdAt is kept from the first write. */
export async function upsertUserProfile(input: UserProfileInput): Promise<UserProfile> {
  const data = parseOrThrow(profileInput, input, (issues) => new ValidationError("Invalid user profile", issues));

  const store = getUserStore();
  const existing = await store.getProfile(data.userId);
  const profile: UserProfile = {
    ...existing,
    ...data,
    createdAt: existing?.createdAt ?? data.createdAt ?? Date.now(),
  };
  await store.saveProfile(profile);
  return profile;
}
