import { config } from "@/config";
import { DAY_MS } from "@/lib/utils/time";
import { betaInterval } from "./beta";
import { reconcileCursor } from "./learning";
import { resolveMode, type ModeResolution } from "./policy";
import { getBanditStore } from "./store";
import type { ArmStats, BanditSummary, BanditVariant } from "./types";

/*
 * Monitoring read model for /api/admin/bandit and the dashboard. Lift is
 * reported with its uncertainty and only called significant when the 95%
 * interval of the difference excludes zero — no improvement is claimed
 * from the model's own scores.
 */

export interface VariantReport {
  variant: BanditVariant;
  exposures: number;
  completions: number;
  /** Completed consultations per exposure, with a 95% interval. */
  rate: number | null;
  interval: [number, number] | null;
  revenue: number;
  margin: number;
  marginPerExposure: number | null;
}

export interface BanditReport {
  generatedAt: string;
  windowDays: number;
  mode: ModeResolution;
  policy: string;
  holdoutShare: number;
  /** Top positions decided by Thompson sampling. */
  slots: number;
  variants: VariantReport[];
  /** treatment − control; null until both have exposures. */
  lift: {
    rateDiff: number;
    interval: [number, number];
    significant: boolean;
    marginPerExposureDiff: number | null;
  } | null;
  providers: (BanditSummary["providers"][number] & { exposureShare: number; targetShare: number | null })[];
  outcomes: BanditSummary["outcomes"];
  topArms: (ArmStats & { mean: number; interval: [number, number] })[];
  reconcile: { lastRunAt: number | null; reconciledTo: number | null; lagSeconds: number | null; last: unknown };
}

function variantReport(v: BanditSummary["variants"][number]): VariantReport {
  const n = v.exposures;
  return {
    variant: v.variant,
    exposures: n,
    completions: v.completions,
    rate: n > 0 ? v.completions / n : null,
    interval: n > 0 ? betaInterval(v.completions + 1, n - Math.min(v.completions, n) + 1) : null,
    revenue: v.revenue,
    margin: v.margin,
    marginPerExposure: n > 0 ? v.margin / n : null,
  };
}

export async function getBanditReport({ windowDays = 30, now = Date.now(), topArms = 20 } = {}): Promise<BanditReport> {
  const cfg = config.ranking.bandit;
  const store = getBanditStore();
  const [mode, summary, arms, cursor] = await Promise.all([
    resolveMode(now),
    store.summarize(cfg.policyVersion, now - windowDays * DAY_MS),
    store.topArms(cfg.policyVersion, topArms),
    reconcileCursor(),
  ]);

  const variants = (["treatment", "control"] as const).map((v) =>
    variantReport(summary.variants.find((x) => x.variant === v) ?? { variant: v, exposures: 0, weightedExposures: 0, completions: 0, revenue: 0, margin: 0 }),
  );
  const [t, c] = variants;
  let lift: BanditReport["lift"] = null;
  if (t.rate !== null && c.rate !== null) {
    const diff = t.rate - c.rate;
    const se = Math.sqrt((t.rate * (1 - t.rate)) / t.exposures + (c.rate * (1 - c.rate)) / c.exposures);
    const interval: [number, number] = [diff - 1.96 * se, diff + 1.96 * se];
    lift = {
      rateDiff: diff,
      interval,
      significant: se > 0 && (interval[0] > 0 || interval[1] < 0),
      marginPerExposureDiff: t.marginPerExposure !== null && c.marginPerExposure !== null ? t.marginPerExposure - c.marginPerExposure : null,
    };
  }

  const totalExposures = summary.providers.reduce((s, p) => s + p.exposures, 0);
  const target = new Map(config.providers.providers.filter((p) => p.enabled).map((p) => [p.id, p.targetShare]));

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays,
    mode,
    policy: cfg.policyVersion,
    holdoutShare: cfg.holdoutShare,
    slots: cfg.slots,
    variants,
    lift,
    providers: summary.providers
      .map((p) => ({ ...p, exposureShare: totalExposures ? p.exposures / totalExposures : 0, targetShare: target.get(p.providerId) ?? null }))
      .sort((a, b) => a.providerId.localeCompare(b.providerId)),
    outcomes: summary.outcomes,
    topArms: arms.map((a) => {
      const alpha = a.successes + 1;
      const beta = Math.max(0, a.trials - a.successes) + 1;
      return { ...a, mean: alpha / (alpha + beta), interval: betaInterval(alpha, beta) };
    }),
    reconcile: {
      lastRunAt: cursor?.lastRunAt ?? null,
      reconciledTo: cursor?.reconciledTo ?? null,
      lagSeconds: cursor ? Math.round((now - cursor.reconciledTo) / 1000) : null,
      last: cursor?.last ?? null,
    },
  };
}
