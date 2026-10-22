import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import type { AdjustmentExplanation } from "@/types/ranking";
import type { ProviderState, SignalContext, SignalInput } from "../types";
import { applyGates, type GateInput } from "./gates";

type BoosterConfig = typeof config.ranking.adjustments.providerBooster;

/**
 * Conversion-aware scaling from provider efficiency (its smoothed
 * conversion ÷ platform rate): boosts shrink for providers that convert
 * poorly, dampening shrinks for providers that convert well.
 */
function performanceFactors(state: ProviderState, cfg: BoosterConfig) {
  if (!cfg.performance.enabled) return { boost: 1, dampen: 1 };
  const e = Math.max(state.efficiency, 1e-6);
  const { minFactor } = cfg.performance;
  return { boost: clamp(e, minFactor, 1), dampen: clamp(1 / e, minFactor, 1) };
}

/**
 * Bounded reduction for providers above target exposure or near capacity:
 *   raw = −max × max(overTarget, overUtilization) × dampenFactor
 * capped at maxRelativeToBase × baseScore. It only ever lowers a score a
 * little, so it needs no quality gate; the user's favourites and previous
 * astrologers are exempt.
 */
function dampener({ features: f }: SignalInput, state: ProviderState, cfg: BoosterConfig, g: GateInput, factor: number) {
  const d = cfg.dampener;
  const overTarget = state.gap < 0 ? clamp(-state.gap / d.saturationGap) : 0;
  const u = state.utilization;
  const overUtilization = u !== null && u > d.utilizationFrom ? clamp((u - d.utilizationFrom) / (1 - d.utilizationFrom)) : 0;
  const pressure = Math.max(overTarget, overUtilization);
  if (!d.enabled || pressure === 0) return { value: 0, raw: 0, note: undefined, overTarget, overUtilization };
  if (d.exemptPersonal && (f.isFavorite === 1 || (f.userCallsWithAstrologer ?? 0) > 0)) {
    return { value: 0, raw: -pressure * d.max * factor, note: "dampener waived (favourite/previous astrologer)", overTarget, overUtilization };
  }
  const raw = -pressure * d.max * factor;
  const cap = cfg.maxRelativeToBase * g.baseScore;
  const value = Math.max(raw, -d.max, -cap);
  const why = overUtilization >= overTarget ? "provider near capacity" : "provider above target exposure";
  return { value, raw, note: value > raw ? `${why}; dampener capped` : why, overTarget, overUtilization };
}

/**
 * Bounded provider adjustment, signed:
 *  - under-target provider with spare capacity → boost
 *      raw = clamp(visibilityGap / saturationGap) × spareCapacity × max × boostFactor
 *    clamped to [min, max], then gated on quality and relevance and capped
 *    relative to baseScore (see gates.ts);
 *  - over-target or over-utilized provider → small negative dampener.
 * visibilityGap = target − actual share of recent top slots; spareCapacity =
 * 1 − utilizationScore; boost/dampen factors come from provider conversion.
 */
export function providerBooster(input: SignalInput, sctx: SignalContext, g: GateInput): AdjustmentExplanation {
  const { astrologer: a } = input;
  const cfg = config.ranking.adjustments.providerBooster;
  const bounds: [number, number] = [cfg.dampener.enabled ? -cfg.dampener.max : cfg.min, cfg.max];
  const state = sctx.providers.get(a.providerId);
  if (!state) {
    return { name: "providerBooster", value: 0, raw: 0, bounds, applied: false, note: "provider state unknown", inputs: { providerId: a.providerId } };
  }

  const factors = performanceFactors(state, cfg);
  const visibility = state.gap > 0 ? clamp(state.gap / cfg.saturationGap) : 0;
  const spare = state.utilization === null ? 1 : clamp(1 - state.utilization);
  let raw = visibility * spare * cfg.max * factors.boost;
  let note: string | undefined;
  if (state.saturated) {
    raw = 0;
    note = "withheld: provider at capacity";
  } else if (state.gap <= 0) {
    note = "provider at or above target exposure";
  }

  const bounded = raw > 0 ? clamp(raw, cfg.min, cfg.max) : 0;
  const gated = applyGates(bounded, cfg, g, sctx);
  const damp = gated.value > 0 ? null : dampener(input, state, cfg, g, factors.dampen);
  const value = gated.value > 0 ? gated.value : (damp?.value ?? 0);

  return {
    name: "providerBooster",
    value,
    raw: gated.value > 0 || !damp || damp.raw === 0 ? raw : damp.raw,
    bounds,
    applied: value !== 0,
    note: value < 0 ? damp?.note : (gated.note ?? damp?.note ?? note),
    inputs: {
      providerId: a.providerId,
      targetShare: state.targetShare,
      actualShare: state.actualShare,
      visibilityGap: state.gap,
      utilizationScore: state.utilization,
      liveUtilization: state.liveUtilization,
      historicalUtilization: state.historicalUtilization,
      occupiedSupply: state.occupiedSupply,
      availableSupply: state.availableSupply,
      spareCapacity: spare,
      providerImpressions: state.impressions,
      providerCompletedCalls: state.completedCalls,
      providerConversion: state.conversionRate,
      efficiency: state.efficiency,
      boostFactor: factors.boost,
      dampenFactor: factors.dampen,
      overTarget: damp?.overTarget ?? 0,
      overUtilization: damp?.overUtilization ?? 0,
      qualityScore: gated.quality,
      relevance: gated.relevance,
    },
  };
}
