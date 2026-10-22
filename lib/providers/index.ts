import { readFile } from "node:fs/promises";
import path from "node:path";
import { config, type ProviderConfig } from "@/config";
import { ConfigurationError, ProviderFeedError } from "@/lib/errors";
import { readFeed } from "./readers";
import { getProviderAdapter } from "./registry";
import type { ProviderAdapter } from "./types";

export type { AvailabilityUpdate, BookingNotice, ProviderAdapter, ProviderAstrologer } from "./types";
export type { FeedFormat, FeedSpec } from "./readers";
export { fetchAvailability } from "./availability";
export { getProviderAdapter };

/** An adapter joined with its business config (targets, capacity, enabled…). */
export interface Provider {
  id: string;
  adapter: ProviderAdapter;
  config: ProviderConfig;
}

export function getProvider(providerId: string): Provider | undefined {
  const adapter = getProviderAdapter(providerId);
  const cfg = config.providers.providers.find((p) => p.id === providerId);
  return adapter && cfg ? { id: providerId, adapter, config: cfg } : undefined;
}

export function listProviders({ enabledOnly = false } = {}): Provider[] {
  return config.providers.providers
    .map((p) => getProvider(p.id))
    .filter((p): p is Provider => p !== undefined && (!enabledOnly || p.config.enabled));
}

/**
 * Reads a provider's feed file into raw records for its adapter.
 * `file` overrides the adapter's default path (relative to the project root).
 */
export async function loadProviderRecords(providerId: string, file?: string): Promise<unknown[]> {
  const adapter = getProviderAdapter(providerId);
  if (!adapter) throw new ConfigurationError("No adapter registered for provider", { providerId });
  const target = file ?? adapter.feed.defaultPath;
  if (!target) throw new ConfigurationError("Provider has no feed file configured", { providerId });

  const context = { providerId, file: target, format: adapter.feed.format };
  let buf: Buffer;
  try {
    buf = await readFile(path.resolve(process.cwd(), target));
  } catch (err) {
    throw new ProviderFeedError("Could not read provider feed", context, { cause: err });
  }
  try {
    return readFeed(buf, adapter.feed);
  } catch (err) {
    throw new ProviderFeedError("Could not parse provider feed", context, { cause: err });
  }
}
