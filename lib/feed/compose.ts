/*
 * Pure slot allocation for the home feed: how many slots each provider
 * gets in a column, and the greedy fill that honours those quotas (and
 * optional rank-band quotas) while keeping the best scores on top.
 */

export interface Entry {
  id: string;
  providerId: string;
  /** Column-specific ordering score (higher first). */
  score: number;
  /** Optional quota group, e.g. a rank band. */
  group?: string;
}

/**
 * Splits `size` slots in proportion to `weights` (largest remainder), never
 * giving a key more than `available[key]`; slots a key can't use are
 * re-shared among the others. Keys without availability get nothing.
 */
export function allocate(
  size: number,
  weights: ReadonlyMap<string, number>,
  available: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  let left = Math.min(size, [...available.values()].reduce((s, n) => s + n, 0));
  let open = [...weights.keys()].filter((k) => (available.get(k) ?? 0) > 0);

  while (left > 0 && open.length > 0) {
    const total = open.reduce((s, k) => s + Math.max(0, weights.get(k) ?? 0), 0);
    // All-zero weights: share evenly.
    const share = (k: string) => (total > 0 ? Math.max(0, weights.get(k) ?? 0) / total : 1 / open.length) * left;
    const room = (k: string) => (available.get(k) ?? 0) - (out.get(k) ?? 0);

    const floors = open.map((k) => ({ k, n: Math.min(Math.floor(share(k)), room(k)), rem: share(k) - Math.floor(share(k)) }));
    let given = 0;
    for (const f of floors) {
      out.set(f.k, (out.get(f.k) ?? 0) + f.n);
      given += f.n;
    }
    for (const f of [...floors].sort((a, b) => b.rem - a.rem || a.k.localeCompare(b.k))) {
      if (given >= left) break;
      if (room(f.k) > 0) {
        out.set(f.k, (out.get(f.k) ?? 0) + 1);
        given++;
      }
    }
    if (given === 0) break;
    left -= given;
    open = open.filter((k) => room(k) > 0);
  }
  return out;
}

/** Weight of the quota deficit against score when interleaving (scores span ~0.1, deficits ~1). */
const DEFICIT_WEIGHT = 1;

export interface ComposeOptions {
  size: number;
  /** Max slots per provider. Providers not listed are uncapped. */
  providerCaps: ReadonlyMap<string, number>;
  /**
   * Interleave providers by how far each is behind its quota at every
   * position, instead of pure score order (which could stack one provider on top).
   */
  interleave?: boolean;
  /** Max slots per group; entries whose group isn't listed are unconstrained. */
  groupQuota?: ReadonlyMap<string, number>;
}

/**
 * Greedy column fill. Each slot takes the best entry that keeps every
 * provider within its cap and every group within its quota; with
 * `interleave`, being behind quota outweighs score. If no entry fits, group
 * quotas are dropped first, then provider caps, so the column still fills.
 */
export function compose<T extends Entry>(pool: readonly T[], { size, providerCaps, interleave = false, groupQuota }: ComposeOptions): T[] {
  const out: T[] = [];
  const used = new Set<string>();
  const byProvider = new Map<string, number>();
  const byGroup = new Map<string, number>();
  const n = Math.min(size, pool.length);

  const deficit = (quota: number | undefined, placed: number, pos: number) =>
    quota === undefined ? 0 : (quota * (pos + 1)) / n - placed;

  for (let pos = 0; pos < n; pos++) {
    let best: T | undefined;
    for (const relax of [0, 1, 2]) {
      let bestKey = -Infinity;
      for (const e of pool) {
        if (used.has(e.id)) continue;
        const placedP = byProvider.get(e.providerId) ?? 0;
        const placedG = e.group === undefined ? 0 : (byGroup.get(e.group) ?? 0);
        const cap = providerCaps.get(e.providerId);
        const gq = e.group === undefined ? undefined : groupQuota?.get(e.group);
        if (relax < 2 && cap !== undefined && placedP >= cap) continue;
        if (relax < 1 && gq !== undefined && placedG >= gq) continue;
        const key =
          e.score +
          (interleave ? DEFICIT_WEIGHT * deficit(cap, placedP, pos) : 0) +
          (relax < 1 ? DEFICIT_WEIGHT * deficit(gq, placedG, pos) : 0);
        if (key > bestKey) [best, bestKey] = [e, key];
      }
      if (best) break;
    }
    if (!best) break;
    used.add(best.id);
    out.push(best);
    byProvider.set(best.providerId, (byProvider.get(best.providerId) ?? 0) + 1);
    if (best.group !== undefined) byGroup.set(best.group, (byGroup.get(best.group) ?? 0) + 1);
  }
  return out;
}
