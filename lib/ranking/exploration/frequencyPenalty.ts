import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import type { AdjustmentExplanation } from "@/types/ranking";
import type { SignalContext, SignalInput } from "../types";

/**
 * Penalty for being shown too often recently (magnitude, subtracted):
 *   viewer part = max(0, impressions to this user/session − free) × perUserImpression
 *   global part = max(0, share of recent impressions / fair share − multiple) × perExcessShare
 * clamped to [0, max]. The viewer part is skipped for the user's favourites
 * and previously consulted astrologers when exemptPersonal is on.
 */
export function frequencyPenalty({ astrologer: a, features: f }: SignalInput, sctx: SignalContext): AdjustmentExplanation {
  const cfg = config.ranking.adjustments.frequencyPenalty;
  const seen = sctx.exposure.byAstrologer.get(a.id);
  const viewer = seen?.viewer ?? 0;
  const global = seen?.global ?? 0;

  const personal = f.isFavorite === 1 || (f.userCallsWithAstrologer ?? 0) > 0;
  const exempt = cfg.exemptPersonal && personal;
  const viewerPart = exempt ? 0 : Math.max(0, viewer - cfg.freeUserImpressions) * cfg.perUserImpression;

  let globalPart = 0;
  let shareMultiple: number | null = null;
  if (sctx.exposure.recentTotal >= cfg.minWindowImpressions && sctx.candidateCount > 0) {
    const fair = sctx.exposure.recentTotal / sctx.candidateCount;
    shareMultiple = global / fair;
    globalPart = Math.max(0, shareMultiple - cfg.globalOverexposureMultiple) * cfg.perExcessShare;
  }

  const raw = viewerPart + globalPart;
  const magnitude = clamp(raw, 0, cfg.max);
  return {
    name: "frequencyPenalty",
    value: -magnitude,
    raw,
    bounds: [0, cfg.max],
    applied: magnitude > 0,
    note: exempt && viewer > cfg.freeUserImpressions ? "viewer fatigue waived (favourite/previous astrologer)" : raw > cfg.max ? "capped" : undefined,
    inputs: { viewerImpressions: viewer, globalImpressions: global, shareMultiple, viewerPart, globalPart, exempt: exempt ? 1 : 0 },
  };
}
