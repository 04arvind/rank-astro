import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import type { AstrologerProfile } from "@/types/astrologer";
import { betaMean } from "./beta";
import { ANY_CONTEXT, type ArmStats } from "./types";

/*
 * Arm keys and the hierarchical Beta posterior:
 *
 *   provider rate   pP = (sP + p0·k0) / (nP + k0)                 platform prior p0
 *   astrologer      Beta(pA·kA + s, (1 − pA)·kA + n − s)          overall, every context
 *                   pA = pP × layer2                              Layer-2 prior multiplier
 *   context arm     Beta(m·kC + sc, (1 − m)·kC + nc − sc)         m = astrologer mean,
 *                                                                 kC = min(contextStrength, α+β)
 *
 * so a new astrologer starts at their provider's observed rate scaled by
 * how well Layer 2 ranks them, and a category with no data falls back to
 * the astrologer's overall rate. Data overrides the prior as it accrues.
 */

type Cfg = typeof config.ranking.bandit;

export const astrologerArmId = (policy: string, context: string, astrologerId: string) => `${policy}|${context}|a:${astrologerId}`;
export const providerArmId = (policy: string, providerId: string) => `${policy}|${ANY_CONTEXT}|p:${providerId}`;

/** The request's category, or ANY_CONTEXT. Arms learn per category. */
export const contextKeyOf = (category: string | undefined) => (category ? category.toLowerCase() : ANY_CONTEXT);

export interface Posterior {
  alpha: number;
  beta: number;
  mean: number;
  providerRate: number;
  /** pA: the prior mean before this astrologer's own data. */
  priorMean: number;
  /** Raw counters behind it (overall arm / context arm). */
  trials: number;
  successes: number;
  contextTrials: number;
  contextSuccesses: number;
}

const counts = (arm: ArmStats | undefined) => {
  const trials = Math.max(0, arm?.trials ?? 0);
  // Successes can't exceed weighted trials in a Beta: clamp, keeping α, β > 0.
  const successes = Math.min(Math.max(0, arm?.successes ?? 0), trials);
  return { trials, successes };
};

export function posteriorFor(
  a: Pick<AstrologerProfile, "id" | "providerId">,
  context: string,
  arms: ReadonlyMap<string, ArmStats>,
  policy: string,
  cfg: Cfg = config.ranking.bandit,
  /** Layer-2 prior multiplier (1 = provider rate as is). */
  layer2 = 1,
): Posterior {
  const { rate, providerStrength, astrologerStrength, contextStrength } = cfg.prior;
  const p = counts(arms.get(providerArmId(policy, a.providerId)));
  const providerRate = clamp((p.successes + rate * providerStrength) / (p.trials + providerStrength), 1e-6, 1 - 1e-6);

  const priorMean = clamp(providerRate * layer2, 1e-6, 0.5);
  const g = counts(arms.get(astrologerArmId(policy, ANY_CONTEXT, a.id)));
  let alpha = priorMean * astrologerStrength + g.successes;
  let beta = (1 - priorMean) * astrologerStrength + (g.trials - g.successes);

  let c = { trials: 0, successes: 0 };
  if (context !== ANY_CONTEXT) {
    c = counts(arms.get(astrologerArmId(policy, context, a.id)));
    const m = betaMean(alpha, beta);
    const k = Math.min(contextStrength, alpha + beta);
    alpha = m * k + c.successes;
    beta = (1 - m) * k + (c.trials - c.successes);
  }

  return {
    alpha,
    beta,
    mean: betaMean(alpha, beta),
    providerRate,
    priorMean,
    trials: g.trials,
    successes: g.successes,
    contextTrials: c.trials,
    contextSuccesses: c.successes,
  };
}

/** Arm ids a candidate's posterior reads. */
export function armIdsFor(a: Pick<AstrologerProfile, "id" | "providerId">, context: string, policy: string): string[] {
  const ids = [providerArmId(policy, a.providerId), astrologerArmId(policy, ANY_CONTEXT, a.id)];
  if (context !== ANY_CONTEXT) ids.push(astrologerArmId(policy, context, a.id));
  return ids;
}

/** Platform share of each ₹ billed: the astrologer's payout when known, else the provider's revenue share. */
export function marginRateOf(a: Pick<AstrologerProfile, "providerId" | "pricing">): number {
  const { perMinute, payoutPerMinute } = a.pricing;
  if (payoutPerMinute !== null && perMinute > 0) return clamp((perMinute - payoutPerMinute) / perMinute);
  return config.providers.providers.find((p) => p.id === a.providerId)?.revenueShare ?? 0;
}

/** Expected platform margin of one consultation: price × expected minutes × margin rate. */
export function expectedMarginPerConsultation(a: Pick<AstrologerProfile, "providerId" | "pricing">, avgCallMinutes: number | null): number {
  const minutes = avgCallMinutes ?? config.business.revenue.defaultCallMinutes;
  return a.pricing.perMinute * minutes * marginRateOf(a);
}
