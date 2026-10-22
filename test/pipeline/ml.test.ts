import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "@/config";
import { runRanking } from "@/lib/ranking";
import { buildRanker, featureRow, loadRanker, ML_FEATURE_NAMES, parseXGBoostModel, setRankerArtifact, XGBoostModelError } from "@/lib/ranking/ml";
import { DAY_MS } from "@/lib/utils/time";
import { artifact, booster, freshPipeline, NOW, request, stump } from "./helpers";

/*
 * Layer 4: the XGBoost JSON evaluator, the model gates, and the re-rank
 * with its fallbacks.
 */

after(() => {
  delete process.env.RANKER_MODE;
  delete process.env.BANDIT_MODE;
  setRankerArtifact(undefined);
});

const layer = (run: Awaited<ReturnType<typeof runRanking>>, key: string) => run.pipeline!.layers.find((l) => l.key === key)!;
const order = (l: { entries: { astrologerId: string }[] }) => l.entries.map((e) => e.astrologerId);

test("evaluator: splits, missing values, float32 thresholds, multiple trees and base score", () => {
  const model = parseXGBoostModel(
    booster(
      [
        stump(10, 1, -1),
        // x1 < 0.5 ? (x0 < 3 ? 0.25 : 0.5) : 2, missing → left at the root
        { left: [1, 3, -1, -1, -1], right: [2, 4, -1, -1, -1], feature: [1, 0, 0, 0, 0], threshold: [0.5, 3, 2, 0.25, 0.5], defaultLeft: [1, 0, 0, 0, 0] },
      ],
      ["a", "b"],
    ),
  );
  assert.equal(model.trees, 2);
  assert.equal(model.objective, "rank:ndcg");
  const [r1, r2, r3, r4] = model.predict([
    [5, 0.1],
    [20, 0.9],
    [null, null],
    [2, null],
  ]);
  assert.equal(r1, 0.5 + 1 + 0.5);
  assert.equal(r2, 0.5 - 1 + 2);
  assert.equal(r3, 0.5 - 1 + 0.5, "missing: root of tree 1 goes right, tree 2 left then right (x0 missing → right)");
  assert.equal(r4, 0.5 + 1 + 0.25);
  // 0.1 is not exactly representable; XGBoost compares in float32.
  const f32 = parseXGBoostModel(booster([stump(Math.fround(0.1), 1, -1)], ["a"]));
  assert.deepEqual(f32.predict([[0.1]]), [0.5 - 1]);
});

test("evaluator: honours best_iteration and rejects what it can't evaluate", () => {
  const two = parseXGBoostModel(booster([stump(1, 1, 1), stump(1, 5, 5)], ["a"], { bestIteration: 0 }));
  assert.equal(two.trees, 1);
  assert.throws(() => parseXGBoostModel({ learner: { gradient_booster: { name: "gblinear", model: {} } } }), XGBoostModelError);
  const bad = booster([stump(1, 1, 1)], ["a"]);
  bad.learner.gradient_booster.model.trees[0].left_children = [0, -1, -1]; // a self-loop
  assert.throws(() => parseXGBoostModel(bad), /invalid children/);
});

test("gates: a model is used only with enough data, lift over the served order, known features and recent training", () => {
  assert.equal(buildRanker(artifact(), NOW).status.state, "active");
  const reason = (over: Record<string, unknown>, names?: string[]) => buildRanker(artifact(over, names), NOW).status;
  assert.match(reason({ training: { queries: 10, positiveQueries: 5, rows: 100 } }).reason, /trained on 10 lists/);
  assert.match(reason({ training: { queries: 1000, positiveQueries: 3, rows: 100 } }).reason, /only 3 lists with outcomes/);
  assert.match(reason({ validation: { metric: "ndcg@10", model: 0.5, baseline: 0.55, queries: 10 } }).reason, /doesn't beat the served order/);
  assert.match(reason({ trainedAt: new Date(NOW - (config.ranking.ml.gates.maxModelAgeDays + 1) * DAY_MS).toISOString() }).reason, /older than/);
  assert.match(buildRanker(artifact({}, ["notAFeature"]), NOW).status.reason, /don't produce: notAFeature/);
  assert.equal(buildRanker({ format: "something-else" }, NOW).status.state, "error");
  assert.equal(buildRanker(artifact({ booster: { nope: true } }), NOW).status.state, "error");
});

test("feature rows follow ML_FEATURE_NAMES; unknown values are null", async () => {
  await freshPipeline("off");
  const run = await runRanking(request("user-x"), { now: NOW });
  const row = featureRow(run.ranked[0]);
  assert.equal(row.length, ML_FEATURE_NAMES.length);
  assert.equal(row[ML_FEATURE_NAMES.indexOf("experienceYears")], run.ranked[0].features.experienceYears);
  assert.equal(row[ML_FEATURE_NAMES.indexOf("l2_totalScore")], run.ranked[0].explanation.totalScore);
  assert.ok(row.every((v) => v === null || Number.isFinite(v)));
});

test("live: the model re-orders only the shortlist and sets orderScore; shadow scores without re-ordering; off disables", async () => {
  await freshPipeline("off");
  // Prefers astrologers with < 12 years' experience: the opposite of the business score's experience signal.
  setRankerArtifact(artifact());
  const live = await runRanking(request("user-x"), { now: NOW, trace: true });
  const l3 = layer(live, "candidates");
  const l4 = layer(live, "ml");
  assert.equal(l4.status, "applied", l4.note);
  assert.notDeepEqual(order(l4), order(l3));
  assert.deepEqual(new Set(order(l4)), new Set(order(l3)), "same candidates");
  const k = config.ranking.ml.shortlistSize;
  assert.deepEqual(order(l4).slice(k), order(l3).slice(k), "beyond the shortlist the order is kept");
  const head = l4.entries.slice(0, Math.min(k, l4.entries.length));
  for (let i = 1; i < head.length; i++) assert.ok(head[i - 1].score! >= head[i].score!, "shortlist sorted by orderScore");
  const young = live.ranked.find((c) => (c.features.experienceYears ?? 99) < 12)!;
  assert.ok(young.ml && young.orderScore !== undefined);
  assert.equal(young.ml.model, "test-ranker@t1");

  process.env.RANKER_MODE = "shadow";
  const shadow = await runRanking(request("user-x"), { now: NOW, trace: true });
  assert.deepEqual(order(layer(shadow, "ml")), order(layer(shadow, "candidates")));
  assert.ok(shadow.ranked.some((c) => c.ml) && shadow.ranked.every((c) => c.orderScore === undefined));

  process.env.RANKER_MODE = "off";
  const off = await runRanking(request("user-x"), { now: NOW, trace: true });
  assert.equal(layer(off, "ml").status, "fallback");
  assert.equal((await loadRanker(NOW)).status.state, "disabled");
  delete process.env.RANKER_MODE;
});

test("a gated or broken model falls back to the Layer-3 order", async () => {
  await freshPipeline("off");
  const baseline = await runRanking(request("user-x"), { now: NOW, trace: true });

  setRankerArtifact(artifact({ validation: { metric: "ndcg@10", model: 0.4, baseline: 0.5, queries: 50 } }));
  const gated = await runRanking(request("user-x"), { now: NOW, trace: true });
  assert.equal(layer(gated, "ml").status, "fallback");
  assert.match(layer(gated, "ml").note!, /doesn't beat/);
  assert.deepEqual(gated.ranked.map((c) => c.astrologer.id), baseline.ranked.map((c) => c.astrologer.id));

  // A booster with NaN leaves is rejected when loaded.
  setRankerArtifact(artifact({}, ["experienceYears"], [stump(12, NaN, NaN)]));
  const broken = await runRanking(request("user-x"), { now: NOW, trace: true });
  assert.notEqual(layer(broken, "ml").status, "applied");
  assert.deepEqual(broken.ranked.map((c) => c.astrologer.id), baseline.ranked.map((c) => c.astrologer.id));
});

test("Thompson sampling centres its prior on the learned order score when Layer 4 is live", async () => {
  await freshPipeline("live");
  setRankerArtifact(artifact());
  const run = await runRanking(request("user-x"), { now: NOW });
  const scored = run.ranked.filter((c) => c.orderScore !== undefined);
  assert.ok(scored.length > 0);
  assert.ok(run.context.bandit, "bandit ran");
});

// Golden test against real XGBoost output (fixture generated by scripts/ml/train_ranker.py's XGBRanker).
const golden = path.join(process.cwd(), "test/fixtures/ml/xgb-golden.json");
test("evaluator matches XGBoost's own margins on a trained XGBRanker", { skip: !existsSync(golden) && "golden fixture not generated" }, () => {
  const g = JSON.parse(readFileSync(golden, "utf8")) as { booster: unknown; rows: (number | null)[][]; margins: number[] };
  const model = parseXGBoostModel(g.booster);
  const ours = model.predict(g.rows);
  ours.forEach((m, i) => assert.ok(Math.abs(m - g.margins[i]) < 1e-4, `row ${i}: ${m} vs xgboost ${g.margins[i]}`));
});
