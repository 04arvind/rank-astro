import { config } from "@/config";
import { getProviderMetrics } from "@/lib/analytics";
import { bayesianAverage } from "@/lib/utils/normalization";
import type { ProviderMetrics } from "@/types/analytics";
import type { AstrologerProfile } from "@/types/astrologer";
import type { ProviderState } from "../types";
import { currentUtilization, isSaturated, liveSupply } from "./utilization";

// Exponentially smoothed exposure share per provider, kept across requests.
const g = globalThis as unknown as {
  __providerShareEma?: Map<string, number>;
  __providerPerformance?: { at: number; byId: Map<string, ProviderMetrics>; platformRate: number };
};
const ema = (g.__providerShareEma ??= new Map());

/** Clears the smoothed exposure history and cached performance (tests, simulations). */
export function resetProviderStates(): void {
  ema.clear();
  g.__providerPerformance = undefined;
}

/**
 * Provider impressions and completed calls over the performance window,
 * plus the platform-wide conversion rate. Cached for cacheSeconds of the
 * ranking clock so every request doesn't re-scan a day of events.
 */
async function providerPerformance(now: number) {
  const { windowHours, cacheSeconds, priorStrengthImpressions } = config.providers.performance;
  const cached = g.__providerPerformance;
  if (cached && Math.abs(now - cached.at) < cacheSeconds * 1000) return cached;

  const metrics = await getProviderMetrics({ window: { from: now - windowHours * 3_600_000, to: now } });
  const impressions = metrics.reduce((s, m) => s + m.impressions, 0);
  const completed = metrics.reduce((s, m) => s + m.completedCalls, 0);
  const platformRate = bayesianAverage(completed, impressions, config.business.conversion.priorRate, priorStrengthImpressions);
  const fresh = { at: now, byId: new Map(metrics.map((m) => [m.providerId, m])), platformRate };
  g.__providerPerformance = fresh;
  return fresh;
}

/**
 * Target vs. actual top-N exposure, utilization and conversion per enabled
 * provider. Targets are renormalized over `activeProviderIds` (providers
 * that have eligible astrologers for this request), so an empty provider's
 * target doesn't make everyone else look over-exposed. With no recent
 * traffic, actual = target (no correction).
 *
 * utilization = max(live, historical) of whichever is known:
 *   live       = occupiedSupply / availableSupply (busy / online+busy) from `supply`
 *   historical = call-minutes / configured capacity
 */
export async function getProviderStates(
  now = Date.now(),
  activeProviderIds?: ReadonlySet<string>,
  supply: readonly AstrologerProfile[] = [],
): Promise<Map<string, ProviderState>> {
  const { windowMinutes, smoothing } = config.providers.utilization;
  const { priorStrengthImpressions } = config.providers.performance;
  const [metrics, perf] = await Promise.all([
    getProviderMetrics({ window: { from: now - windowMinutes * 60_000, to: now } }),
    providerPerformance(now),
  ]);
  const byId = new Map(metrics.map((m) => [m.providerId, m]));
  const live = liveSupply(supply);

  const enabled = config.providers.providers.filter((p) => p.enabled);
  const active = activeProviderIds?.size ? enabled.filter((p) => activeProviderIds.has(p.id)) : enabled;
  const activeTotal = active.reduce((s, p) => s + p.targetShare, 0);
  const activeTopN = active.reduce((s, p) => s + (byId.get(p.id)?.topNImpressions ?? 0), 0);

  const out = new Map<string, ProviderState>();
  for (const p of enabled) {
    const isActive = active.includes(p);
    const target = isActive && activeTotal > 0 ? p.targetShare / activeTotal : 0;
    const m = byId.get(p.id);
    // Share among active providers only, matching the renormalized targets.
    const observed = activeTopN > 0 ? (isActive ? (m?.topNImpressions ?? 0) / activeTopN : 0) : target;
    const prev = ema.get(p.id) ?? observed;
    const actual = smoothing * observed + (1 - smoothing) * prev;
    ema.set(p.id, actual);

    const s = live.get(p.id) ?? { occupied: 0, available: 0, utilization: null };
    const historical = currentUtilization(m);
    const known = [s.utilization, historical].filter((v): v is number => v !== null);
    const utilization = known.length ? Math.max(...known) : null;

    const pm = perf.byId.get(p.id);
    const impressions = pm?.impressions ?? 0;
    const completedCalls = pm?.completedCalls ?? 0;
    const conversionRate = bayesianAverage(completedCalls, impressions, perf.platformRate, priorStrengthImpressions);

    out.set(p.id, {
      providerId: p.id,
      targetShare: target,
      configuredTargetShare: p.targetShare,
      actualShare: actual,
      gap: target - actual,
      utilization,
      saturated: isSaturated(utilization),
      occupiedSupply: s.occupied,
      availableSupply: s.available,
      liveUtilization: s.utilization,
      historicalUtilization: historical,
      impressions,
      completedCalls,
      conversionRate,
      efficiency: perf.platformRate > 0 ? conversionRate / perf.platformRate : 1,
    });
  }
  return out;
}
