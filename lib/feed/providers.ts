import { config } from "@/config";
import type { ProviderState } from "@/lib/ranking";
import { clamp } from "@/lib/utils/math";
import { allocate } from "./compose";

/**
 * Normalizes weights to sum to 1 while keeping each inside [min, max]:
 * clamped keys are fixed and the rest re-share what's left (water-filling).
 * Bounds that can't all hold (e.g. maxes summing below 1) are relaxed.
 */
export function boundedShares(
  weights: ReadonlyMap<string, number>,
  bounds: ReadonlyMap<string, { min: number; max: number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  let free = [...weights.keys()];
  let budget = 1;
  for (let pass = 0; pass <= weights.size && free.length > 0; pass++) {
    const total = free.reduce((s, k) => s + (weights.get(k) ?? 0), 0);
    const share = (k: string) => (total > 0 ? ((weights.get(k) ?? 0) / total) * budget : budget / free.length);
    const violated = free.filter((k) => {
      const b = bounds.get(k);
      return b && (share(k) < b.min || share(k) > b.max);
    });
    if (violated.length === 0) {
      for (const k of free) out.set(k, share(k));
      return out;
    }
    for (const k of violated) {
      const b = bounds.get(k)!;
      out.set(k, clamp(share(k), b.min, b.max));
      budget -= out.get(k)!;
    }
    free = free.filter((k) => !violated.includes(k));
  }
  // Every key got clamped: rescale what we have so it still sums to 1.
  const total = [...out.values()].reduce((s, v) => s + v, 0);
  for (const [k, v] of out) out.set(k, total > 0 ? v / total : 1 / out.size);
  return out;
}

/**
 * Page-level share each provider should get, from live marketplace state:
 *   w = targetShare × exposure × capacity × efficiency
 *   exposure   = clamp(1 + gapGain × gap/targetShare)   gap = target − recent top-slot share
 *   capacity   = clamp(1 + spareGain × (0.5 − utilization)), or saturatedFactor at capacity
 *   efficiency = clamp(conversion ÷ platform conversion)
 * then held inside share.min/max and maxPageShare. So an over-exposed or
 * busy provider gets fewer slots, an under-exposed one with spare capacity
 * more, Provider A never exceeds its page cap, and everyone keeps a floor.
 */
export function providerWeights(states: ReadonlyMap<string, ProviderState>): Map<string, number> {
  const b = config.feed.providerBalance;
  const raw = new Map<string, number>();
  for (const s of states.values()) {
    if (s.targetShare <= 0) continue;
    const exposure = clamp(1 + (b.gapGain * s.gap) / s.targetShare, b.exposureFactor.min, b.exposureFactor.max);
    const capacity = s.saturated
      ? b.saturatedFactor
      : s.utilization === null
        ? 1
        : clamp(1 + b.spareGain * (0.5 - s.utilization), b.capacityFactor.min, b.capacityFactor.max);
    const efficiency = clamp(s.efficiency, b.efficiencyFactor.min, b.efficiencyFactor.max);
    raw.set(s.providerId, s.targetShare * exposure * capacity * efficiency);
  }

  const bounds = new Map<string, { min: number; max: number }>();
  for (const p of config.providers.providers) {
    if (!raw.has(p.id)) continue;
    const cap = b.maxPageShare[p.id];
    bounds.set(p.id, { min: p.share.min, max: cap === undefined ? p.share.max : Math.min(cap, p.share.max) });
  }
  return boundedShares(raw, bounds);
}

/**
 * Score nudge for the Recommended column: positive for an under-exposed
 * provider with spare capacity, negative for an over-exposed one, at most
 * ±providerBoostMax.
 */
export function providerNudge(state: ProviderState | undefined): number {
  if (!state || state.targetShare <= 0) return 0;
  const max = config.feed.recommended.providerBoostMax;
  const pressure = clamp(state.gap / state.targetShare, -1, 1);
  if (pressure > 0) {
    if (state.saturated) return 0;
    const spare = state.utilization === null ? 1 : clamp(1 - state.utilization);
    return max * pressure * spare;
  }
  return max * pressure;
}

/**
 * Tracks how many slots each provider already got on the page, so each
 * column's quotas make up for the columns before it (e.g. Provider C, with
 * no premium-priced astrologers, gets more room in the other columns).
 */
export class PageBudget {
  private readonly placed = new Map<string, number>();
  private total = 0;

  constructor(private readonly weights: ReadonlyMap<string, number>) {}

  /**
   * Slot quotas for a column of `size` drawn from a pool with `available`
   * astrologers per provider. Catching up on the page never lets one
   * provider take more than its max share of a single column.
   */
  quotas(size: number, available: ReadonlyMap<string, number>): Map<string, number> {
    const pageAfter = this.total + size;
    const owed = new Map<string, number>();
    for (const [id, w] of this.weights) owed.set(id, Math.max(0, w * pageAfter - (this.placed.get(id) ?? 0)));
    // Providers without a weight (unknown state) still share leftovers.
    for (const id of available.keys()) if (!owed.has(id)) owed.set(id, 0);
    const capped = new Map([...available].map(([id, n]) => [id, Math.min(n, columnCap(id, size))]));
    return allocate(size, owed, capped);
  }

  record(providerIds: readonly string[]): void {
    for (const id of providerIds) this.placed.set(id, (this.placed.get(id) ?? 0) + 1);
    this.total += providerIds.length;
  }

  counts(): ReadonlyMap<string, number> {
    return this.placed;
  }
}

/** Most slots a provider may hold in one column: its max share (and page cap) of the column, rounded up. */
export function columnCap(providerId: string, size: number): number {
  const p = config.providers.providers.find((x) => x.id === providerId);
  if (!p) return size;
  const pageCap = config.feed.providerBalance.maxPageShare[providerId];
  return Math.ceil(Math.min(p.share.max, pageCap ?? 1) * size);
}

export function countByProvider(items: readonly { providerId: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of items) out.set(i.providerId, (out.get(i.providerId) ?? 0) + 1);
  return out;
}
