import type { AstrologerProfile } from "@/types/astrologer";
import type { PipelineFiltered, PipelineLayer, PipelineLayerKey, PipelineTrace } from "@/types/ranking";

/*
 * Records the list after every layer of runRanking, for the admin pipeline
 * view (debug runs only — `trace: true`). Snapshots hold ids, ranks and
 * scores, not candidates, so a trace is cheap and safe to serialize.
 *
 *   1 Eligibility            hard filters (lib/astrologer/eligibility)
 *   2 Business ranking       weighted business score (score.ts, business/pillars.ts)
 *   3 Candidate generation   retrieval cap + diversity/guardrail ordering + ML shortlist
 *   4 ML ranking             XGBoost LambdaMART re-rank of the shortlist (ml/)
 *   5 Exploration            exploration slots + contextual Thompson sampling (bandit/)
 *   6 Final re-ranking       revalidation, dedupe, constraints, safe order (final/)
 */

export const LAYERS: Record<PipelineLayerKey, Pick<PipelineLayer, "layer" | "title" | "description" | "scoreLabel">> = {
  eligibility: {
    layer: 1,
    title: "Eligibility",
    description: "Hard filters: provider enabled, verified profile, price bounds, availability / online-only, quality floors.",
    scoreLabel: "—",
  },
  business: {
    layer: 2,
    title: "Business ranking",
    description: "Weighted score of booking probability, profit/margin, quality, personalization, availability, provider utilization and exposure fairness.",
    scoreLabel: "totalScore",
  },
  candidates: {
    layer: 3,
    title: "Candidate generation",
    description: "Retrieval cap, diversity and business guardrails (provider/premium caps, provider floors); the top of this list is the learned ranker's shortlist.",
    scoreLabel: "totalScore (with diversity)",
  },
  ml: {
    layer: 4,
    title: "ML ranking",
    description: "XGBoost LambdaMART (rank:ndcg) re-orders the shortlist by a blend of model and business score; falls back to the Layer-3 order.",
    scoreLabel: "orderScore (model blend)",
  },
  exploration: {
    layer: 5,
    title: "Exploration",
    description: "Exploration slots for new / under-exposed astrologers, then contextual Thompson sampling assigns the top slots (conversion × margin × fair exposure).",
    scoreLabel: "orderScore",
  },
  final: {
    layer: 6,
    title: "Final re-ranking",
    description: "Re-checks eligibility and availability, removes duplicates, repairs business constraints and renumbers before serving.",
    scoreLabel: "orderScore",
  },
};

type Listed = { astrologer: Pick<AstrologerProfile, "id" | "providerId"> };

export interface LayerRecord<T extends Listed> {
  list: readonly T[];
  score?: (item: T) => number | null;
  inputCount: number;
  filtered?: PipelineFiltered[];
  status: PipelineLayer["status"];
  note?: string;
  durationMs: number;
  details?: PipelineLayer["details"];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export class PipelineRecorder {
  private readonly layers: PipelineLayer[] = [];
  private readonly started = performance.now();

  constructor(readonly enabled: boolean) {}

  add<T extends Listed>(key: PipelineLayerKey, r: LayerRecord<T>): void {
    if (!this.enabled) return;
    this.layers.push({
      ...LAYERS[key],
      key,
      status: r.status,
      note: r.note,
      durationMs: round(r.durationMs),
      inputCount: r.inputCount,
      outputCount: r.list.length,
      entries: r.list.map((c, i) => {
        const s = r.score?.(c) ?? null;
        return { astrologerId: c.astrologer.id, providerId: c.astrologer.providerId, rank: i + 1, score: s === null || !Number.isFinite(s) ? null : s };
      }),
      filtered: r.filtered ?? [],
      details: r.details,
    });
  }

  trace(): PipelineTrace | undefined {
    if (!this.enabled) return undefined;
    return { layers: [...this.layers].sort((a, b) => a.layer - b.layer), totalMs: round(performance.now() - this.started), generatedAt: new Date().toISOString() };
  }
}

/** Milliseconds since `t0` (performance.now()). */
export const since = (t0: number) => performance.now() - t0;

/** Whether two lists have the same ids in the same order. */
export const sameOrder = (a: readonly Listed[], b: readonly Listed[]) => a.length === b.length && a.every((c, i) => c.astrologer.id === b[i].astrologer.id);
