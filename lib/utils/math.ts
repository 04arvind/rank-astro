/** numerator / denominator, or null when the denominator is 0. */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function clamp(v: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, v));
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Arithmetic mean, or null for an empty list. */
export function mean(values: readonly number[]): number | null {
  return ratio(sum(values), values.length);
}

/** Rounds to `digits` decimal places (half away from zero). */
export function round(v: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.sign(v) * Math.round(Math.abs(v) * f) / f;
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Deterministic hash of a string to [0, 1) — FNV-1a, for seeded choices. */
export function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}
