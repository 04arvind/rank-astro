import { clamp } from "./math";

/*
 * Generic value → [0, 1] transforms. They carry no business meaning; callers
 * pick the transform and supply the parameters from config.
 */

/** Linear rescale of [min, max] onto [0, 1], clamped. Degenerate ranges → 0. */
export function minMax(v: number, min: number, max: number): number {
  return max > min ? clamp((v - min) / (max - min)) : 0;
}

/** log(1 + v) / log(1 + saturation): fast early growth, 1 at saturation. */
export function logSaturation(v: number, saturation: number): number {
  return saturation > 0 ? clamp(Math.log1p(Math.max(0, v)) / Math.log1p(saturation)) : 0;
}

/** v / (v + half): 0.5 at `half`, approaching 1. */
export function hyperbolic(v: number, half: number): number {
  return v <= 0 ? 0 : v / (v + half);
}

/** 0.5^(age / halfLife): 1 when fresh, 0.5 after one half-life. */
export function halfLifeDecay(age: number, halfLife: number): number {
  return halfLife > 0 ? Math.pow(0.5, Math.max(0, age) / halfLife) : 0;
}

/** e^(−excess / scale): 1 at 0 excess, decaying smoothly. */
export function expDecay(excess: number, scale: number): number {
  return Math.exp(-Math.max(0, excess) / Math.max(scale, 1e-9));
}

/**
 * Shrinks an observed average toward a prior:
 * (prior·priorWeight + observedSum) / (priorWeight + n).
 * With n = 0 it returns the prior.
 */
export function bayesianAverage(observedSum: number, n: number, prior: number, priorWeight: number): number {
  const w = Math.max(0, priorWeight);
  return w + n > 0 ? (prior * w + observedSum) / (w + n) : prior;
}

/** Scales values so they sum to 1; all-zero input returns zeros. */
export function normalizeToUnitSum<K extends string>(values: Readonly<Record<K, number>>): Record<K, number> {
  const total = Object.values<number>(values).reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    Object.entries<number>(values).map(([k, v]) => [k, total > 0 ? v / total : 0]),
  ) as Record<K, number>;
}

/** Converts a count map into shares of `total` (defaults to the map's sum). */
export function toShares<K>(counts: ReadonlyMap<K, number>, total?: number): Map<K, number> {
  const t = total ?? [...counts.values()].reduce((a, b) => a + b, 0);
  return new Map([...counts].map(([k, v]) => [k, t > 0 ? v / t : 0]));
}
