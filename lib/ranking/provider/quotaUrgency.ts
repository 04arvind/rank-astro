import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import type { AdjustmentExplanation } from "@/types/ranking";
import type { SignalContext, SignalInput } from "../types";
import { applyGates, type GateInput } from "./gates";

/** Start of the current quota period (aligned to local midnight) and fraction elapsed. */
export function quotaPeriod(now: number): { start: number; end: number; elapsed: number } {
  const { periodHours, timezoneOffsetMinutes } = config.ranking.adjustments.quotaUrgency;
  const periodMs = periodHours * 3_600_000;
  const offset = timezoneOffsetMinutes * 60_000;
  const start = Math.floor((now + offset) / periodMs) * periodMs - offset;
  return { start, end: start + periodMs, elapsed: clamp((now - start) / periodMs) };
}

/**
 * quotaUrgencyScore = max(providerDeficit, astrologerDeficit) × elapsed^exponent
 *  - providerDeficit: how far the provider's share of this period's top slots
 *    is behind its (renormalized) target, as a fraction of target;
 *  - astrologerDeficit: shortfall against an optional per-astrologer quota.
 * Urgency grows as the period runs out. Boost = urgency × max, gated like the
 * provider booster. Saturated providers can't absorb more traffic, so their
 * provider deficit is ignored.
 */
export function quotaUrgencyBoost({ astrologer: a }: SignalInput, sctx: SignalContext, g: GateInput): AdjustmentExplanation & { urgency: number } {
  const cfg = config.ranking.adjustments.quotaUrgency;
  const state = sctx.providers.get(a.providerId);
  const { topNTotal, providerShare } = sctx.exposure.period;

  let providerDeficit = 0;
  if (state && !state.saturated && topNTotal >= cfg.minPeriodImpressions && state.targetShare > 0) {
    providerDeficit = clamp((state.targetShare - (providerShare.get(a.providerId) ?? 0)) / state.targetShare);
  }

  const quota = cfg.astrologerQuotas[a.id];
  const shown = sctx.exposure.byAstrologer.get(a.id)?.period ?? 0;
  const astrologerDeficit = quota ? clamp((quota - shown) / quota) : 0;

  const pressure = Math.pow(sctx.periodElapsed, cfg.timePressureExponent);
  const urgency = Math.max(providerDeficit, astrologerDeficit) * pressure;
  const raw = urgency * cfg.max;
  const gated = applyGates(clamp(raw, 0, cfg.max), cfg, g, sctx);

  return {
    name: "quotaUrgencyBoost",
    urgency,
    value: gated.value,
    raw,
    bounds: [0, cfg.max],
    applied: gated.applied,
    note:
      gated.note ??
      (state?.saturated ? "provider at capacity" : topNTotal < cfg.minPeriodImpressions ? `waiting for ${cfg.minPeriodImpressions} period impressions` : undefined),
    inputs: {
      providerDeficit,
      astrologerDeficit,
      periodShare: providerShare.get(a.providerId) ?? 0,
      targetShare: state?.targetShare ?? null,
      astrologerQuota: quota ?? null,
      astrologerPeriodImpressions: shown,
      periodElapsed: sctx.periodElapsed,
      timePressure: pressure,
    },
  };
}
