/*
 * Minimal evaluator for XGBoost's JSON model format (Booster.save_model
 * "*.json" / save_raw("json")), gbtree boosters with numerical splits —
 * what scripts/ml/train_ranker.py produces. Inference is a sum of tree
 * leaves, so it runs in-process with no native dependency.
 *
 *   margin(x) = base_score + Σ_trees leaf(tree, x)
 *   at a split: go left if x[f] < threshold, missing (null/NaN) → default_left
 *
 * Thresholds and features are compared as float32, like XGBoost does.
 */

interface Tree {
  left: Int32Array;
  right: Int32Array;
  feature: Int32Array;
  threshold: Float32Array;
  defaultLeft: Uint8Array;
}

export interface XGBoostModel {
  featureNames: readonly string[];
  objective: string;
  baseScore: number;
  trees: number;
  /** Margins (raw scores) for rows in featureNames order. */
  predict(rows: readonly (readonly (number | null)[])[]): number[];
}

export class XGBoostModelError extends Error {
  override name = "XGBoostModelError";
}

type Json = Record<string, unknown>;

const obj = (v: unknown, path: string): Json => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new XGBoostModelError(`${path}: expected an object`);
  return v as Json;
};
const arr = (v: unknown, path: string): unknown[] => {
  if (!Array.isArray(v)) throw new XGBoostModelError(`${path}: expected an array`);
  return v;
};
const num = (v: unknown, path: string): number => {
  // XGBoost writes some scalars as strings, e.g. "5E-1" or "[5E-1]" (multi-target builds).
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/^\[|\]$/g, "").split(",")[0]) : NaN;
  if (!Number.isFinite(n)) throw new XGBoostModelError(`${path}: expected a number, got ${JSON.stringify(v)}`);
  return n;
};

function parseTree(t: Json, i: number): Tree {
  const p = `trees[${i}]`;
  const left = arr(t.left_children, `${p}.left_children`).map((x) => num(x, `${p}.left_children`));
  const n = left.length;
  const field = (name: string) => {
    const a = arr(t[name], `${p}.${name}`);
    if (a.length !== n) throw new XGBoostModelError(`${p}.${name}: length ${a.length} ≠ ${n}`);
    return a;
  };
  const right = field("right_children").map((x) => num(x, `${p}.right_children`));
  const feature = field("split_indices").map((x) => num(x, `${p}.split_indices`));
  const threshold = field("split_conditions").map((x) => num(x, `${p}.split_conditions`));
  const defaultLeft = field("default_left").map((x) => (x === true || x === 1 || x === "1" ? 1 : 0));
  const splitType = Array.isArray(t.split_type) ? t.split_type : [];
  if (splitType.some((s) => s !== 0 && s !== "0")) throw new XGBoostModelError(`${p}: categorical splits are not supported`);
  for (let k = 0; k < n; k++) {
    const leaf = left[k] === -1;
    if (!leaf && (left[k] <= k || right[k] <= k || left[k] >= n || right[k] >= n)) {
      throw new XGBoostModelError(`${p}: node ${k} has invalid children`);
    }
  }
  return {
    left: Int32Array.from(left),
    right: Int32Array.from(right),
    feature: Int32Array.from(feature),
    threshold: Float32Array.from(threshold),
    defaultLeft: Uint8Array.from(defaultLeft),
  };
}

function leafValue(tree: Tree, row: readonly (number | null)[]): number {
  let node = 0;
  // Children always have higher indices than their parent (checked on parse), so this terminates.
  while (tree.left[node] !== -1) {
    const x = row[tree.feature[node]];
    if (x === null || x === undefined || Number.isNaN(x)) node = tree.defaultLeft[node] ? tree.left[node] : tree.right[node];
    else node = Math.fround(x) < tree.threshold[node] ? tree.left[node] : tree.right[node];
  }
  return tree.threshold[node]; // a leaf's split_condition holds its value
}

/** Parses an XGBoost JSON model; throws XGBoostModelError on anything it can't evaluate faithfully. */
export function parseXGBoostModel(json: unknown): XGBoostModel {
  const learner = obj(obj(json, "model").learner, "learner");
  const booster = obj(learner.gradient_booster, "gradient_booster");
  if (booster.name !== "gbtree") throw new XGBoostModelError(`booster "${String(booster.name)}" is not supported (gbtree only)`);
  const model = obj(booster.model, "gradient_booster.model");
  const param = obj(learner.learner_model_param, "learner_model_param");
  if (num(param.num_class ?? 0, "num_class") > 1) throw new XGBoostModelError("multi-class models are not supported");
  if (num(param.num_target ?? 1, "num_target") > 1) throw new XGBoostModelError("multi-target models are not supported");

  let trees = arr(model.trees, "model.trees").map((t, i) => parseTree(obj(t, `trees[${i}]`), i));
  // Honour early stopping if the model kept its extra trees.
  const best = (learner.attributes as Json | undefined)?.best_iteration;
  if (best !== undefined) {
    const perRound = Math.max(1, num(obj(model.gbtree_model_param ?? {}, "gbtree_model_param").num_parallel_tree ?? 1, "num_parallel_tree"));
    trees = trees.slice(0, (num(best, "best_iteration") + 1) * perRound);
  }

  const featureNames = arr(learner.feature_names ?? [], "feature_names").map(String);
  const numFeature = num(param.num_feature, "num_feature");
  if (featureNames.length && featureNames.length !== numFeature) {
    throw new XGBoostModelError(`feature_names has ${featureNames.length} entries, num_feature is ${numFeature}`);
  }
  for (const t of trees) for (let k = 0; k < t.left.length; k++) {
    if (t.left[k] !== -1 && (t.feature[k] < 0 || t.feature[k] >= numFeature)) throw new XGBoostModelError("split on an out-of-range feature");
  }

  const baseScore = num(param.base_score ?? 0, "base_score");
  const objective = String(obj(learner.objective ?? {}, "objective").name ?? "unknown");
  return {
    featureNames,
    objective,
    baseScore,
    trees: trees.length,
    predict(rows) {
      return rows.map((row) => {
        let s = baseScore;
        for (const t of trees) s += leafValue(t, row);
        return s;
      });
    },
  };
}
