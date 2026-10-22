import { config } from "@/config";
import { logError, ProviderError, ProviderTimeoutError, toAppError } from "@/lib/errors";
import type { AstrologerProfile } from "@/types/astrologer";
import { getProviderAdapter } from "./registry";
import type { AvailabilityUpdate } from "./types";

type Target = Pick<AstrologerProfile, "id" | "providerId" | "sourceId" | "externalId">;

const nativeId = (t: Target) => t.externalId ?? t.sourceId;

const cache = new Map<string, { value: AvailabilityUpdate; expires: number }>();

/**
 * Live availability for the given astrologers, keyed by astrologer id.
 * Calls each provider's API in parallel with a timeout; a slow or failing
 * provider is logged and skipped so one outage can't block ranking.
 * Astrologers without an update keep their stored status.
 */
export async function fetchAvailability(
  astrologers: readonly Target[],
  now = Date.now(),
): Promise<Map<string, AvailabilityUpdate>> {
  const { timeoutMs, cacheSeconds } = config.providers.availability;
  const out = new Map<string, AvailabilityUpdate>();
  const pending = new Map<string, Target[]>();

  for (const a of astrologers) {
    const hit = cache.get(a.id);
    if (hit && hit.expires > now) out.set(a.id, hit.value);
    else pending.set(a.providerId, [...(pending.get(a.providerId) ?? []), a]);
  }

  await Promise.all(
    [...pending].map(async ([providerId, targets]) => {
      const fetcher = getProviderAdapter(providerId)?.fetchAvailability;
      if (!fetcher) return;
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const updates = await fetcher(targets.map(nativeId), signal);
        for (const t of targets) {
          const u = updates.get(nativeId(t));
          if (!u) continue;
          out.set(t.id, u);
          cache.set(t.id, { value: u, expires: now + cacheSeconds * 1000 });
        }
      } catch (err) {
        // Degrade gracefully: stored statuses stay in place.
        const context = { providerId, operation: "availability", targets: targets.length };
        const error = signal.aborted
          ? new ProviderTimeoutError({ ...context, timeoutMs }, { cause: err })
          : toAppError(err, (cause) => new ProviderError("Availability fetch failed", context, { cause }));
        logError(error, { scope: "providers" });
      }
    }),
  );
  return out;
}
