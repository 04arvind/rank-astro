import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "@/config";
import { logError, RankingError } from "@/lib/errors";
import { DAY_MS } from "@/lib/utils/time";
import { ML_FEATURE_NAMES } from "./features";
import { parseXGBoostModel, type XGBoostModel } from "./xgboost";

/*
 * Loads the Layer-4 model artifact written by scripts/ml/train_ranker.py:
 * training metadata + the XGBoost JSON booster. A model is only used when
 * it was trained on enough served lists with outcomes, beat the served
 * (production) order on held-out lists, is recent, and every feature it
 * splits on is one we produce. Anything else — no file, a corrupt file, a
 * gate not met — is a reported fallback, never an error for the request.
 */

export const ARTIFACT_FORMAT = "rank-astro/xgb-ranker@1";

const artifactSchema = z.object({
  format: z.literal(ARTIFACT_FORMAT),
  name: z.string().min(1),
  version: z.string().min(1),
  objective: z.string().min(1),
  trainedAt: z.string().min(1),
  featureNames: z.array(z.string().min(1)).min(1),
  training: z.object({ queries: z.number().int().nonnegative(), positiveQueries: z.number().int().nonnegative(), rows: z.number().int().nonnegative() }).passthrough(),
  validation: z.object({ metric: z.string(), model: z.number(), baseline: z.number(), queries: z.number().int().nonnegative() }).passthrough(),
  booster: z.unknown(),
});

export type RankerArtifact = z.infer<typeof artifactSchema>;
export type RankerMode = "off" | "shadow" | "live";

export interface RankerInfo {
  name: string;
  version: string;
  objective: string;
  trainedAt: string;
  trees: number;
  features: number;
  training: RankerArtifact["training"];
  validation: RankerArtifact["validation"];
}

export interface RankerStatus {
  mode: RankerMode;
  /** active: scoring requests · disabled: off by config/env · unavailable: no model file · gated: model rejected by a gate · error: unreadable/invalid. */
  state: "active" | "disabled" | "unavailable" | "gated" | "error";
  reason: string;
  source: string;
  model?: RankerInfo;
}

export interface LoadedRanker {
  info: RankerInfo;
  /** Margins for candidate rows in ML_FEATURE_NAMES order. */
  score(rows: readonly (readonly (number | null)[])[]): number[];
}

export interface RankerLoad {
  status: RankerStatus;
  ranker?: LoadedRanker;
}

const MODES: readonly RankerMode[] = ["off", "shadow", "live"];

/** RANKER_MODE env (deploy-time switch) > config (enabled → live). */
export function rankerMode(): RankerMode {
  const env = process.env.RANKER_MODE?.trim().toLowerCase() as RankerMode | undefined;
  if (env && MODES.includes(env)) return env;
  return config.ranking.ml.enabled ? "live" : "off";
}

export const modelPath = () => path.resolve(process.cwd(), process.env.RANKER_MODEL_PATH?.trim() || config.ranking.ml.modelPath);

/** Builds a ranker from an artifact, or says which gate it failed. */
export function buildRanker(raw: unknown, now = Date.now(), source = "memory"): RankerLoad {
  const mode = rankerMode();
  const parsed = artifactSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: { mode, state: "error", reason: `invalid artifact: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`, source } };
  }
  const a = parsed.data;
  let model: XGBoostModel;
  try {
    model = parseXGBoostModel(a.booster);
  } catch (err) {
    return { status: { mode, state: "error", reason: `invalid booster: ${err instanceof Error ? err.message : String(err)}`, source } };
  }
  const info: RankerInfo = {
    name: a.name,
    version: a.version,
    objective: a.objective,
    trainedAt: a.trainedAt,
    trees: model.trees,
    features: a.featureNames.length,
    training: a.training,
    validation: a.validation,
  };
  const gated = (reason: string): RankerLoad => ({ status: { mode, state: "gated", reason, source, model: info } });

  // Rows are built by name, so the model may use any subset of our features, in any order.
  const index = new Map(ML_FEATURE_NAMES.map((n, i) => [n, i]));
  const unknown = a.featureNames.filter((n) => !index.has(n));
  if (unknown.length) return gated(`model uses features we don't produce: ${unknown.slice(0, 5).join(", ")}`);
  if (model.featureNames.length && model.featureNames.join() !== a.featureNames.join()) return gated("booster feature_names differ from the artifact's");
  if (!a.objective.startsWith("rank:")) return gated(`objective ${a.objective} is not a ranking objective`);

  const g = config.ranking.ml.gates;
  if (a.training.queries < g.minTrainingQueries) return gated(`trained on ${a.training.queries} lists (< ${g.minTrainingQueries})`);
  if (a.training.positiveQueries < g.minPositiveQueries) return gated(`only ${a.training.positiveQueries} lists with outcomes (< ${g.minPositiveQueries})`);
  if (g.requireLiftOverBaseline && !(a.validation.model > a.validation.baseline)) {
    return gated(`validation ${a.validation.metric} ${a.validation.model.toFixed(4)} doesn't beat the served order (${a.validation.baseline.toFixed(4)})`);
  }
  const trainedAt = Date.parse(a.trainedAt);
  if (!Number.isFinite(trainedAt)) return gated("trainedAt is not a date");
  if (now - trainedAt > g.maxModelAgeDays * DAY_MS) return gated(`model is older than ${g.maxModelAgeDays} days`);

  const columns = a.featureNames.map((n) => index.get(n)!);
  const ranker: LoadedRanker = {
    info,
    score: (rows) => model.predict(rows.map((r) => columns.map((i) => r[i] ?? null))),
  };
  return { status: { mode, state: "active", reason: `${a.name} ${a.version} (${model.trees} trees)`, source, model: info }, ranker };
}

const g = globalThis as unknown as {
  __ranker?: { at: number; key: string; load: RankerLoad };
  __rankerOverride?: unknown;
};

/** Tests / tooling: use this artifact instead of the file (null = no model); undefined restores the file. */
export function setRankerArtifact(artifact: unknown | null | undefined): void {
  g.__rankerOverride = artifact;
  g.__ranker = undefined;
}

export function resetRankerCache(): void {
  g.__ranker = undefined;
}

/** The current ranker, cached for config.ranking.ml.cacheSeconds (re-read when the file changes). Never throws. */
export async function loadRanker(now = Date.now()): Promise<RankerLoad> {
  const mode = rankerMode();
  if (mode === "off") return { status: { mode, state: "disabled", reason: "learned ranker is off (config or RANKER_MODE)", source: "config" } };

  if (g.__rankerOverride !== undefined) {
    if (g.__rankerOverride === null) return { status: { mode, state: "unavailable", reason: "no model installed", source: "override" } };
    const load = buildRanker(g.__rankerOverride, now, "override");
    return { ...load, status: { ...load.status, mode } };
  }

  const file = modelPath();
  const ttl = config.ranking.ml.cacheSeconds * 1000;
  const cached = g.__ranker;
  if (cached && now - cached.at < ttl) return { ...cached.load, status: { ...cached.load.status, mode } };

  let load: RankerLoad;
  let key = "missing";
  try {
    const s = await stat(file);
    key = `${s.mtimeMs}:${s.size}`;
    if (cached && cached.key === key) {
      g.__ranker = { ...cached, at: now };
      return { ...cached.load, status: { ...cached.load.status, mode } };
    }
    load = buildRanker(JSON.parse(await readFile(file, "utf8")), now, path.relative(process.cwd(), file));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    load = missing
      ? { status: { mode, state: "unavailable", reason: "no trained model yet — run npm run ml:export then npm run ml:train", source: path.relative(process.cwd(), file) } }
      : { status: { mode, state: "error", reason: `could not read model: ${err instanceof Error ? err.message : String(err)}`, source: path.relative(process.cwd(), file) } };
  }
  if (load.status.state === "error" || load.status.state === "gated") {
    // Logged once per load, not per request.
    if (!cached || cached.key !== key) logError(new RankingError("ml", `learned ranker not used: ${load.status.reason}`), { scope: "ranking", operation: "loadRanker" });
  } else if (load.status.state === "active" && (!cached || cached.key !== key)) {
    console.info(`[ranking] learned ranker loaded: ${load.status.reason}`);
  }
  g.__ranker = { at: now, key, load };
  return load;
}
