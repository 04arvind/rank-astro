/** Counts items per key. */
export function countBy<T, K = string>(items: Iterable<T>, key: (item: T) => K): Map<K, number> {
  const counts = new Map<K, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** Groups items per key, preserving input order within each group. */
export function groupBy<T, K = string>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** Map from key to item; later items win on duplicate keys. */
export function keyBy<T, K = string>(items: Iterable<T>, key: (item: T) => K): Map<K, T> {
  const out = new Map<K, T>();
  for (const item of items) out.set(key(item), item);
  return out;
}

/** Sums a numeric projection per key. */
export function sumBy<T, K = string>(items: Iterable<T>, key: (item: T) => K, value: (item: T) => number): Map<K, number> {
  const out = new Map<K, number>();
  for (const item of items) {
    const k = key(item);
    out.set(k, (out.get(k) ?? 0) + value(item));
  }
  return out;
}

/** Keeps the first item per key. */
export function uniqueBy<T, K>(items: Iterable<T>, key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

export function partition<T>(items: Iterable<T>, predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (predicate(item) ? yes : no).push(item);
  return [yes, no];
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Entries sorted by value, highest first. */
export function topEntries<K>(map: ReadonlyMap<K, number>, limit = Infinity): [K, number][] {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
