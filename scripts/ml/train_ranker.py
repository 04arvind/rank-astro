"""
Trains the Layer-4 learned ranker: XGBoost LambdaMART (XGBRanker, rank:ndcg).

    pip install -r scripts/ml/requirements.txt
    npm run ml:export            # data/ml/training.jsonl + training.meta.json
    npm run ml:train             # data/models/ranker.json (only if it qualifies)

Each served list is one query group; labels are graded relevance
(3 completed consultation, 2 booked, 1 clicked, 0 shown). The newest
--valid-share of lists (by time) is held out. The model is written only if

  * there are at least --min-queries lists and --min-positive lists with an outcome, and
  * its validation NDCG@k beats the served order (what production showed) on the
    same held-out lists — unless --force.

The artifact embeds the XGBoost JSON booster plus that metadata; the app
re-checks the same gates when it loads it (lib/ranking/ml/model.ts), so a
model that doesn't qualify is never used. Exit codes: 0 written, 3 not enough
data, 4 no lift over the served order, 2 bad input.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

ARTIFACT_FORMAT = "rank-astro/xgb-ranker@1"


def load_rows(path: str):
    rows = []
    with open(path, encoding="utf8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                sys.exit(f"{path}:{n}: invalid JSON ({e})")
    return rows


def group(rows):
    """qid -> rows, groups ordered by time (oldest first), items by served position."""
    by_q: dict[str, list] = {}
    for r in rows:
        by_q.setdefault(r["qid"], []).append(r)
    groups = [sorted(g, key=lambda r: r["position"]) for g in by_q.values() if len(g) >= 2]
    groups.sort(key=lambda g: g[0]["at"])
    return groups


def dcg(labels, k):
    return sum((2 ** l - 1) / math.log2(i + 2) for i, l in enumerate(labels[:k]))


def mean_ndcg(groups, scores, k):
    """NDCG@k averaged over groups that have any positive label (others are undefined)."""
    vals = []
    for g, s in zip(groups, scores):
        labels = [r["label"] for r in g]
        ideal = dcg(sorted(labels, reverse=True), k)
        if ideal == 0:
            continue
        order = sorted(range(len(g)), key=lambda i: -s[i])
        vals.append(dcg([labels[i] for i in order], k) / ideal)
    return sum(vals) / len(vals) if vals else 0.0


def matrix(groups, n_features):
    import numpy as np

    X = np.array([[math.nan if v is None else float(v) for v in r["features"]] for g in groups for r in g], dtype=np.float32)
    if X.size and X.shape[1] != n_features:
        sys.exit(f"rows have {X.shape[1]} features, meta lists {n_features}")
    y = np.array([r["label"] for g in groups for r in g], dtype=np.float32)
    qid = np.array([gi for gi, g in enumerate(groups) for _ in g], dtype=np.int64)
    return X, y, qid


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml/training.jsonl")
    p.add_argument("--meta", default="data/ml/training.meta.json")
    p.add_argument("--out", default="data/models/ranker.json")
    p.add_argument("--min-queries", type=int, default=200)
    p.add_argument("--min-positive", type=int, default=30)
    p.add_argument("--valid-share", type=float, default=0.2)
    p.add_argument("--k", type=int, default=10, help="NDCG cut-off")
    p.add_argument("--n-estimators", type=int, default=400)
    p.add_argument("--learning-rate", type=float, default=0.05)
    p.add_argument("--max-depth", type=int, default=6)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--force", action="store_true", help="write the model even without lift (the app still applies its gates)")
    a = p.parse_args()

    try:
        import xgboost as xgb
    except ImportError:
        sys.exit("xgboost is not installed: pip install -r scripts/ml/requirements.txt")

    with open(a.meta, encoding="utf8") as f:
        meta = json.load(f)
    names = meta["featureNames"]
    groups = group(load_rows(a.data))
    positive = [g for g in groups if any(r["label"] > 0 for r in g)]
    print(f"{len(groups)} lists ({len(positive)} with an outcome), {sum(len(g) for g in groups)} rows, {len(names)} features")
    if len(groups) < a.min_queries or len(positive) < a.min_positive:
        print(f"not enough training data (need {a.min_queries} lists / {a.min_positive} with an outcome); the app keeps its current ranking")
        return 3

    cut = max(1, int(len(groups) * (1 - a.valid_share)))
    train, valid = groups[:cut], groups[cut:]
    if not valid or not any(any(r["label"] > 0 for r in g) for g in valid):
        print("the validation split has no outcomes; collect more data or raise --valid-share")
        return 3

    X_tr, y_tr, q_tr = matrix(train, len(names))
    X_va, y_va, q_va = matrix(valid, len(names))
    model = xgb.XGBRanker(
        objective="rank:ndcg",
        tree_method="hist",
        lambdarank_pair_method="topk",
        lambdarank_num_pair_per_sample=a.k,
        n_estimators=a.n_estimators,
        learning_rate=a.learning_rate,
        max_depth=a.max_depth,
        min_child_weight=1.0,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_lambda=1.0,
        eval_metric=f"ndcg@{a.k}",
        early_stopping_rounds=40,
        random_state=a.seed,
    )
    model.fit(X_tr, y_tr, qid=q_tr, eval_set=[(X_va, y_va)], eval_qid=[q_va], verbose=False)

    booster = model.get_booster()
    best = getattr(model, "best_iteration", None)
    if best is not None:
        booster = booster[: best + 1]  # keep only the trees early stopping chose
    booster.feature_names = list(names)

    dva = xgb.DMatrix(X_va, feature_names=list(names), missing=math.nan)
    pred = booster.predict(dva, output_margin=True)
    offs, scores = 0, []
    for g in valid:
        scores.append(list(pred[offs : offs + len(g)]))
        offs += len(g)
    model_ndcg = mean_ndcg(valid, scores, a.k)
    baseline_ndcg = mean_ndcg(valid, [[-r["position"] for r in g] for g in valid], a.k)
    print(f"validation NDCG@{a.k}: model {model_ndcg:.4f} vs served order {baseline_ndcg:.4f} ({len(valid)} lists)")
    if model_ndcg <= baseline_ndcg and not a.force:
        print("no lift over the served order; model not written (use --force to write it anyway)")
        return 4

    now = datetime.now(timezone.utc)
    artifact = {
        "format": ARTIFACT_FORMAT,
        "name": "xgb-lambdamart",
        "version": now.strftime("%Y%m%d-%H%M%S"),
        "objective": "rank:ndcg",
        "trainedAt": now.isoformat(),
        "featureNames": list(names),
        "featureVersion": meta.get("featureVersion"),
        "training": {
            "queries": len(train) + len(valid),
            "positiveQueries": len(positive),
            "rows": int(len(y_tr) + len(y_va)),
            "trainQueries": len(train),
            "from": meta.get("from"),
            "to": meta.get("to"),
        },
        "validation": {"metric": f"ndcg@{a.k}", "model": model_ndcg, "baseline": baseline_ndcg, "queries": len(valid)},
        "params": {
            "n_estimators": a.n_estimators,
            "best_iteration": best,
            "learning_rate": a.learning_rate,
            "max_depth": a.max_depth,
            "xgboost": xgb.__version__,
        },
        "booster": json.loads(booster.save_raw("json")),
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = f"{a.out}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(artifact, f)
    os.replace(tmp, a.out)  # readers never see a half-written model
    print(f"wrote {a.out} ({booster.num_boosted_rounds()} rounds)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
