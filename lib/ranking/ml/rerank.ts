import { config } from "@/config";
import { logError, RankingError } from "@/lib/errors";
import type { RankedCandidate } from "../types";
import { featureRow } from "./features";
import { loadRanker, type RankerStatus } from "./model";

/*
 * Layer 4 — learned re-ranking of the Layer-3 shortlist (positions
 * 1..shortlistSize). The model's margins are rescaled onto the shortlist's
 * own score range and blended with the business score:
 *
 *   rescaled   = sMin + (m − mMin) / (mMax − mMin) × (sMax − sMin)
 *   orderScore = (1 − blendWeight) × score + blendWeight × rescaled
 *
 * so the result stays in score units (Thompson's prior reads it) and a
 * blendWeight below 1 keeps the business ranking in the loop. Live mode
 * re-sorts the shortlist by orderScore; shadow mode only records the model
 * output. No model, a failed gate or a scoring error → the input order,
 * unchanged, with the reason in `status`.
 */

export interface MlLayerResult {
  ranked: RankedCandidate[];
  status: RankerStatus;
  /** Candidates the model scored. */
  scored: number;
  /** Whether the order changed. */
  reordered: boolean;
}

export async function mlRerank(order: RankedCandidate[], now: number): Promise<MlLayerResult> {
  const { status, ranker } = await loadRanker(now);
  if (!ranker || status.mode === "off" || order.length === 0) return { ranked: order, status, scored: 0, reordered: false };

  const cfg = config.ranking.ml;
  const shortlist = order.slice(0, cfg.shortlistSize);
  let margins: number[];
  try {
    margins = ranker.score(shortlist.map(featureRow));
    if (margins.length !== shortlist.length || margins.some((m) => !Number.isFinite(m))) throw new Error("model returned non-finite or missing scores");
  } catch (err) {
    logError(new RankingError("ml", "learned ranker failed; keeping the Layer-3 order", { cause: err }), { scope: "ranking" });
    return { ranked: order, status: { ...status, state: "error", reason: `scoring failed: ${err instanceof Error ? err.message : String(err)}` }, scored: 0, reordered: false };
  }

  const scores = shortlist.map((c) => c.score);
  const [sMin, sMax] = [Math.min(...scores), Math.max(...scores)];
  const [mMin, mMax] = [Math.min(...margins), Math.max(...margins)];
  const w = cfg.blendWeight;
  const model = `${ranker.info.name}@${ranker.info.version}`;
  const scored = shortlist.map((c, i) => {
    // All margins equal: the model can't tell them apart, so it defers to the score.
    const rescaled = mMax > mMin ? sMin + ((margins[i] - mMin) / (mMax - mMin)) * (sMax - sMin) : c.score;
    const orderScore = (1 - w) * c.score + w * rescaled;
    return { c, from: i + 1, ml: { score: margins[i], rescaled, orderScore, model } };
  });

  if (status.mode === "shadow") {
    const ranked = [...scored.map(({ c, ml }) => ({ ...c, ml })), ...order.slice(shortlist.length)];
    return { ranked, status, scored: scored.length, reordered: false };
  }

  scored.sort((a, b) => b.ml.orderScore - a.ml.orderScore || a.from - b.from);
  const head = scored.map(({ c, from, ml }, i) => {
    const moved = i + 1 !== from;
    const note = { stage: "ml" as const, note: `learned ranker: #${from} → #${i + 1} (model ${ml.score.toFixed(3)}, orderScore ${ml.orderScore.toFixed(4)})` };
    return { ...c, ml, orderScore: ml.orderScore, adjustments: moved ? [...c.adjustments, note] : c.adjustments };
  });
  const reordered = head.some((c, i) => c.astrologer.id !== shortlist[i].astrologer.id);
  return { ranked: [...head, ...order.slice(shortlist.length)], status, scored: head.length, reordered };
}
