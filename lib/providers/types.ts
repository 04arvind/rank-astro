import type { z } from "zod";
import type { AvailabilityStatus, AstrologerProfile, ProfileField } from "@/types/astrologer";
import type { FeedSpec } from "./readers";

/** What an adapter produces; lib/astrologer adds id, providerId and source. */
export type ProviderAstrologer = Omit<AstrologerProfile, "id" | "providerId" | "source">;

export interface AvailabilityUpdate {
  status: AvailabilityStatus;
  lastActiveAt: number | null;
}

/**
 * Everything provider-specific lives behind this interface: feed format,
 * raw schema, mapping to the common model, and live availability.
 * `rawSchema` picks only the columns the adapter uses, so unused fields
 * (contact details etc.) never leave the adapter.
 */
export interface ProviderAdapter<Raw = unknown> {
  /** Must match an entry in config.providers.providers. */
  id: string;
  feed: FeedSpec;
  rawSchema: z.ZodType<Raw>;
  toProfile(raw: Raw): ProviderAstrologer;
  /**
   * Live availability for the given native ids (externalId ?? sourceId),
   * keyed by the same ids. Omitted when the
   * provider has no availability API (profiles then stay "unknown").
   */
  fetchAvailability?(ids: readonly string[], signal: AbortSignal): Promise<Map<string, AvailabilityUpdate>>;
  /**
   * Pushes a new-booking notice to the astrologer through the provider's
   * own app (native id = externalId ?? sourceId). Omitted when the provider
   * has no such API; the notice then waits in the astrologer's inbox.
   */
  notifyBooking?(notice: BookingNotice, signal: AbortSignal): Promise<void>;
}

export interface BookingNotice {
  astrologerNativeId: string;
  bookingId: string;
  startAt: number;
  endAt: number;
  title: string;
  message: string;
}

/** Collects the fields whose value is undefined. */
export function missingFields(fields: Partial<Record<ProfileField, unknown>>): ProfileField[] {
  return (Object.keys(fields) as ProfileField[]).filter((k) => fields[k] === undefined);
}
