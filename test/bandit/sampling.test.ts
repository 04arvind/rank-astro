import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "@/config";
import { betaInterval, sampleBeta, seededRandom } from "@/lib/ranking/bandit/beta";
import { astrologerArmId, posteriorFor, providerArmId } from "@/lib/ranking/bandit/posterior";
import { ANY_CONTEXT, type ArmStats } from "@/lib/ranking/bandit/types";

const policy = "test";
const arm = (id: string, o: Partial<ArmStats>): [string, ArmStats] => [
  id,
  { id, policy, kind: "astrologer", context: ANY_CONTEXT, providerId: "providerA", trials: 0, successes: 0, revenue: 0, margin: 0, updatedAt: 0, ...o },
];

test("Beta samples have the right mean and spread", () => {
  for (const [a, b] of [[2, 98], [0.5, 0.5], [30, 10]] as const) {
    const rand = seededRandom(`beta:${a}:${b}`);
    const n = 20_000;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const x = sampleBeta(a, b, rand);
      assert.ok(x >= 0 && x <= 1);
      sum += x;
      sq += x * x;
    }
    const mean = sum / n;
    const variance = sq / n - mean * mean;
    const m = a / (a + b);
    const v = (a * b) / ((a + b) ** 2 * (a + b + 1));
    assert.ok(Math.abs(mean - m) < 0.01, `mean ${mean} vs ${m}`);
    assert.ok(Math.abs(variance - v) / v < 0.1, `variance ${variance} vs ${v}`);
  }
});

test("seeded sampling is reproducible", () => {
  const draw = () => sampleBeta(3, 50, seededRandom("viewer:bucket:astro"));
  assert.equal(draw(), draw());
  assert.notEqual(sampleBeta(3, 50, seededRandom("a")), sampleBeta(3, 50, seededRandom("b")));
  const [lo, hi] = betaInterval(3, 50);
  assert.ok(lo < 3 / 53 && hi > 3 / 53);
});

test("no data: posterior is the platform prior", () => {
  const p = posteriorFor({ id: "x", providerId: "providerA" }, ANY_CONTEXT, new Map(), policy);
  assert.ok(Math.abs(p.mean - config.ranking.bandit.prior.rate) < 1e-9);
  assert.equal(p.trials, 0);
});

test("a new astrologer inherits their provider's observed rate", () => {
  const arms = new Map([arm(providerArmId(policy, "providerA"), { kind: "provider", trials: 5000, successes: 400 })]);
  const p = posteriorFor({ id: "new", providerId: "providerA" }, ANY_CONTEXT, arms, policy);
  assert.ok(p.providerRate > 0.06 && p.mean > 0.06, `provider rate ${p.providerRate}`);
});

test("more completions per exposure raise the posterior; a context arm falls back to the overall one", () => {
  const good = new Map([arm(astrologerArmId(policy, ANY_CONTEXT, "a"), { astrologerId: "a", trials: 200, successes: 20 })]);
  const bad = new Map([arm(astrologerArmId(policy, ANY_CONTEXT, "a"), { astrologerId: "a", trials: 200, successes: 0 })]);
  const pGood = posteriorFor({ id: "a", providerId: "providerA" }, "love", good, policy);
  const pBad = posteriorFor({ id: "a", providerId: "providerA" }, "love", bad, policy);
  assert.ok(pGood.mean > 0.05 && pBad.mean < 0.01, `${pGood.mean} vs ${pBad.mean}`);
  assert.equal(pGood.contextTrials, 0);
});

test("successes above trials can't produce an invalid Beta", () => {
  const arms = new Map([arm(astrologerArmId(policy, ANY_CONTEXT, "a"), { astrologerId: "a", trials: 0.4, successes: 3 })]);
  const p = posteriorFor({ id: "a", providerId: "providerA" }, ANY_CONTEXT, arms, policy);
  assert.ok(p.alpha > 0 && p.beta > 0);
});
