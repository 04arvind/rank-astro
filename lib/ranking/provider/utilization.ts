import { config } from "@/config";
import type { ProviderMetrics } from "@/types/analytics";
import type { AstrologerProfile } from "@/types/astrologer";

/** Whether a provider is too busy to take more traffic. */
export function isSaturated(utilization: number | null): boolean {
  return utilization !== null && utilization >= config.providers.utilization.saturationThreshold;
}

/** Current capacity usage: the higher of average and peak, so bursts count. */
export function currentUtilization(m: ProviderMetrics | undefined): number | null {
  if (!m) return null;
  const values = [m.avgUtilization, m.peakUtilization].filter((v): v is number => v !== null);
  return values.length ? Math.max(...values) : null;
}

export interface LiveSupply {
  /** Astrologers on a call right now (status busy). */
  occupied: number;
  /** Astrologers who can serve calls now or shortly (online + busy). */
  available: number;
  /** occupied / available, or null below config.providers.utilization.liveMinSupply. */
  utilization: number | null;
}

/**
 * Live utilization per provider = occupiedSupply / availableSupply, from
 * astrologer statuses. Providers without live statuses (all "unknown")
 * get null and fall back to call-based utilization.
 */
export function liveSupply(astrologers: readonly AstrologerProfile[]): Map<string, LiveSupply> {
  const { liveMinSupply } = config.providers.utilization;
  const counts = new Map<string, { occupied: number; available: number }>();
  for (const a of astrologers) {
    const { status } = a.availability;
    if (status !== "online" && status !== "busy") continue;
    const c = counts.get(a.providerId) ?? { occupied: 0, available: 0 };
    c.available++;
    if (status === "busy") c.occupied++;
    counts.set(a.providerId, c);
  }
  const out = new Map<string, LiveSupply>();
  for (const [id, c] of counts) {
    out.set(id, { ...c, utilization: c.available >= liveMinSupply ? c.occupied / c.available : null });
  }
  return out;
}
