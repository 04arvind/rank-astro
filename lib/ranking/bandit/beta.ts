import { clamp, hashUnit } from "@/lib/utils/math";

/*
 * Seeded Beta sampling for Thompson sampling. Seeded so a viewer's list is
 * stable for config sampleStableSeconds and tests are deterministic.
 */

/** mulberry32 seeded from a string. */
export function seededRandom(seed: string): () => number {
  let a = Math.floor(hashUnit(seed) * 0x100000000) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function standardNormal(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Gamma(shape, 1) by Marsaglia–Tsang; shape < 1 via the boost u^(1/shape). */
export function sampleGamma(shape: number, rand: () => number): number {
  if (shape < 1) {
    let u = 0;
    while (u === 0) u = rand();
    return sampleGamma(shape + 1, rand) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, rand: () => number): number {
  const x = sampleGamma(alpha, rand);
  const y = sampleGamma(beta, rand);
  return x + y > 0 ? x / (x + y) : alpha / (alpha + beta);
}

export const betaMean = (alpha: number, beta: number) => alpha / (alpha + beta);

/** Normal-approximation 95% interval of Beta(alpha, beta), clamped to [0, 1]. */
export function betaInterval(alpha: number, beta: number): [number, number] {
  const n = alpha + beta;
  const m = alpha / n;
  const sd = Math.sqrt((alpha * beta) / (n * n * (n + 1)));
  return [clamp(m - 1.96 * sd), clamp(m + 1.96 * sd)];
}
