"""
Regenerates test/fixtures/ml/xgb-golden.json: a small XGBRanker (rank:ndcg)
trained on synthetic lists with missing values, plus XGBoost's own margins
for a set of rows. test/pipeline/ml.test.ts checks that the in-app
evaluator (lib/ranking/ml/xgboost.ts) reproduces them.

    python scripts/ml/golden_fixture.py
"""

import json
import math
import os

import numpy as np
import xgboost as xgb

OUT = "test/fixtures/ml/xgb-golden.json"


def main() -> None:
    rng = np.random.default_rng(7)
    n_groups, per_group, n_features = 60, 8, 5
    X = rng.normal(size=(n_groups * per_group, n_features)).astype(np.float32)
    X[rng.random(X.shape) < 0.15] = np.nan  # missing values take the default branch
    signal = np.nan_to_num(X[:, 0]) - 0.5 * np.nan_to_num(X[:, 2]) + 0.3 * rng.normal(size=len(X))
    y = np.clip(np.digitize(signal, [0.0, 0.8, 1.6]), 0, 3).astype(np.float32)
    qid = np.repeat(np.arange(n_groups), per_group)

    model = xgb.XGBRanker(objective="rank:ndcg", n_estimators=25, max_depth=4, learning_rate=0.2, tree_method="hist", random_state=1)
    model.fit(X, y, qid=qid)
    booster = model.get_booster()
    booster.feature_names = [f"f{i}" for i in range(n_features)]

    rows = X[:40]
    margins = booster.predict(xgb.DMatrix(rows, feature_names=booster.feature_names, missing=math.nan), output_margin=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf8") as f:
        json.dump(
            {
                "xgboost": xgb.__version__,
                "booster": json.loads(booster.save_raw("json")),
                "rows": [[None if math.isnan(v) else float(v) for v in r] for r in rows.tolist()],
                "margins": [float(m) for m in margins],
            },
            f,
        )
    print(f"wrote {OUT} (xgboost {xgb.__version__}, {booster.num_boosted_rounds()} rounds)")


if __name__ == "__main__":
    main()
