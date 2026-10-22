import { resetRankingRuns } from "@/lib/ranking";
import { ARTIFACT_FORMAT, InMemoryTrainingLogStore, setRankerArtifact, setTrainingLogStore } from "@/lib/ranking/ml";
import { DAY_MS } from "@/lib/utils/time";
import { NOW } from "@/test/fixtures";
import { freshBandit } from "../bandit/helpers";

export { request, viewerIn } from "../bandit/helpers";
export { ASTRO, NOW } from "@/test/fixtures";

/** Fresh fixtures, bandit off unless asked, no learned model, empty training log. */
export async function freshPipeline(mode: "off" | "shadow" | "live" = "off", options: Parameters<typeof freshBandit>[1] = {}) {
  const stores = await freshBandit(mode, options);
  resetRankingRuns();
  delete process.env.RANKER_MODE;
  setRankerArtifact(null);
  const trainingLog = new InMemoryTrainingLogStore();
  setTrainingLogStore(trainingLog);
  return { ...stores, trainingLog };
}

export interface TreeSpec {
  left: number[];
  right: number[];
  feature: number[];
  /** Split threshold for inner nodes, leaf value for leaves. */
  threshold: number[];
  defaultLeft: (0 | 1)[];
}

/** An XGBoost JSON booster (save_raw("json") layout) built from tree specs. */
export function booster(trees: TreeSpec[], featureNames: string[], extra: { bestIteration?: number; baseScore?: string } = {}) {
  return {
    learner: {
      attributes: extra.bestIteration === undefined ? {} : { best_iteration: String(extra.bestIteration) },
      feature_names: featureNames,
      feature_types: featureNames.map(() => "float"),
      gradient_booster: {
        name: "gbtree",
        model: {
          gbtree_model_param: { num_trees: String(trees.length), num_parallel_tree: "1" },
          tree_info: trees.map(() => 0),
          trees: trees.map((t, id) => ({
            id,
            left_children: t.left,
            right_children: t.right,
            split_indices: t.feature,
            split_conditions: t.threshold,
            default_left: t.defaultLeft,
            base_weights: t.threshold,
            split_type: t.left.map(() => 0),
            tree_param: { num_nodes: String(t.left.length), num_feature: String(featureNames.length) },
          })),
        },
      },
      learner_model_param: { base_score: extra.baseScore ?? "5E-1", num_class: "0", num_feature: String(featureNames.length), num_target: "1" },
      objective: { name: "rank:ndcg" },
    },
    version: [3, 0, 0],
  };
}

/** Single split: x[0] < threshold → `below`, else `above`; missing goes right. */
export const stump = (threshold: number, below: number, above: number): TreeSpec => ({
  left: [1, -1, -1],
  right: [2, -1, -1],
  feature: [0, 0, 0],
  threshold: [threshold, below, above],
  defaultLeft: [0, 0, 0],
});

/** A model artifact that passes every gate unless overridden. */
export function artifact(over: Record<string, unknown> = {}, featureNames = ["experienceYears"], trees = [stump(12, 1, -1)]) {
  return {
    format: ARTIFACT_FORMAT,
    name: "test-ranker",
    version: "t1",
    objective: "rank:ndcg",
    trainedAt: new Date(NOW - DAY_MS).toISOString(),
    featureNames,
    training: { queries: 1000, positiveQueries: 200, rows: 20_000 },
    validation: { metric: "ndcg@10", model: 0.62, baseline: 0.55, queries: 200 },
    booster: booster(trees, featureNames),
    ...over,
  };
}
