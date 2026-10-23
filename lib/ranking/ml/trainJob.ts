import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logError } from "@/lib/errors";
import { z } from "zod";
import { ML_FEATURE_NAMES } from "./features";
import { modelPath, resetRankerCache } from "./model";
import { buildTrainingSet, type TrainingRow } from "./trainingLog";

/*
 * Layer-4 training started from the admin dashboard. One run at a time:
 * export the training set for [from, to) (same as npm run ml:export), then
 * run scripts/ml/train_ranker.py (same as npm run ml:train), which writes
 * the model only when it beats the served order. Status lives in memory.
 */

export type TrainingJobState = "running" | "trained" | "not_written" | "failed";

export interface TrainingJob {
  id: string;
  from: number;
  to: number;
  state: TrainingJobState;
  step: "export" | "train" | "done";
  startedAt: number;
  finishedAt?: number;
  message: string;
  data?: { queries: number; positiveQueries: number; rows: number };
  /** Name of the imported data file, when one was added to the logged data. */
  imported?: string;
  log: string[];
}

const importRowSchema = z.object({
  qid: z.string().min(1),
  at: z.number().finite(),
  astrologerId: z.string().min(1),
  position: z.number().int().nonnegative(),
  label: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  features: z.array(z.number().finite().nullable()).length(ML_FEATURE_NAMES.length),
});

/** Parses an imported training.jsonl (the ml:export row format); returns rows or up to 20 line errors. */
export function parseTrainingRows(text: string): { rows: TrainingRow[]; errors: { path: string; message: string }[] } {
  const rows: TrainingRow[] = [];
  const errors: { path: string; message: string }[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || errors.length >= 20) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return void errors.push({ path: `line ${i + 1}`, message: "invalid JSON" });
    }
    const r = importRowSchema.safeParse(json);
    if (r.success) rows.push(r.data);
    else errors.push({ path: `line ${i + 1}`, message: r.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
  });
  return { rows, errors };
}

const MAX_LOG_LINES = 200;
const TIMEOUT_MS = 30 * 60_000;
const DATA_DIR = "data/ml";

const g = globalThis as unknown as { __trainingJob?: TrainingJob };

export const getTrainingJob = (): TrainingJob | null => g.__trainingJob ?? null;

/** Starts a run in the background; returns null when one is already running. */
export function startTrainingJob({ from, to, imported }: { from: number; to: number; imported?: { name: string; rows: TrainingRow[] } }): TrainingJob | null {
  if (g.__trainingJob?.state === "running") return null;
  const job: TrainingJob = {
    id: crypto.randomUUID(),
    from,
    to,
    state: "running",
    step: "export",
    startedAt: Date.now(),
    message: "Exporting training data…",
    imported: imported?.name,
    log: [],
  };
  g.__trainingJob = job;
  void run(job, imported?.rows ?? []);
  return job;
}

function push(job: TrainingJob, text: string) {
  for (const line of text.split(/\r?\n/)) if (line.trim()) job.log.push(line);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
}

function finish(job: TrainingJob, state: Exclude<TrainingJobState, "running">, message: string) {
  Object.assign(job, { state, step: "done", message, finishedAt: Date.now() });
}

/** Logged rows plus imported rows in [from, to); a logged (qid, astrologer) wins over an imported one. */
function merge(logged: TrainingRow[], imported: TrainingRow[], from: number, to: number) {
  const seen = new Set(logged.map((r) => `${r.qid}|${r.astrologerId}`));
  const extra = imported.filter((r) => r.at >= from && r.at < to && !seen.has(`${r.qid}|${r.astrologerId}`));
  const rows = [...logged, ...extra];
  const queries = new Map<string, boolean>();
  for (const r of rows) queries.set(r.qid, (queries.get(r.qid) ?? false) || r.label > 0);
  return { rows, extra: extra.length, queries: queries.size, positiveQueries: [...queries.values()].filter(Boolean).length };
}

async function run(job: TrainingJob, imported: TrainingRow[]) {
  try {
    const logged = await buildTrainingSet({ from: job.from, to: job.to, now: Date.now() });
    push(job, `logged: ${logged.queries} lists · ${logged.positiveQueries} with an outcome · ${logged.rows.length} rows`);
    const m = merge(logged.rows, imported, job.from, job.to);
    if (job.imported) push(job, `imported ${job.imported}: ${m.extra} of ${imported.length} rows in range added`);
    const set = { ...logged, rows: m.rows, queries: m.queries, positiveQueries: m.positiveQueries };
    job.data = { queries: set.queries, positiveQueries: set.positiveQueries, rows: set.rows.length };
    push(job, `training on ${set.queries} lists · ${set.positiveQueries} with an outcome · ${set.rows.length} rows`);

    const dir = path.resolve(process.cwd(), DATA_DIR);
    await mkdir(dir, { recursive: true });
    const data = path.join(dir, "training.jsonl");
    const meta = path.join(dir, "training.meta.json");
    const jsonl = set.rows.map((r) => JSON.stringify(r)).join("\n");
    await writeFile(data, jsonl ? `${jsonl}\n` : "", "utf8");
    await writeFile(
      meta,
      `${JSON.stringify(
        {
          featureNames: set.featureNames,
          featureVersion: set.featureVersion,
          exportedAt: new Date().toISOString(),
          from: new Date(set.from).toISOString(),
          to: new Date(set.to).toISOString(),
          queries: set.queries,
          positiveQueries: set.positiveQueries,
          rows: set.rows.length,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    Object.assign(job, { step: "train", message: "Training XGBoost ranker…" });
    const script = path.join(process.cwd(), "scripts", "ml", "train_ranker.py");
    const code = await python([script, "--data", data, "--meta", meta, "--out", modelPath()], job);

    if (code === 0) {
      resetRankerCache(); // pick the new model up on the next request
      finish(job, "trained", "New model written — Layer 4 uses it from the next request (if it passes the app's gates).");
    } else if (code === 3) finish(job, "not_written", "Not enough training data in this range; the current model is kept.");
    else if (code === 4) finish(job, "not_written", "The new model didn't beat the served order; the current model is kept.");
    else finish(job, "failed", `Training script exited with code ${code}.`);
  } catch (err) {
    logError(err, { scope: "ranking", operation: "trainingJob" });
    push(job, err instanceof Error ? err.message : String(err));
    finish(job, "failed", "Training failed — see the log.");
  }
}

/** $PYTHON, else the uv venv in scripts/ml (where xgboost is installed), else "python". */
function pythonExecutable(): string {
  const fromEnv = process.env.PYTHON?.trim();
  if (fromEnv) return fromEnv;
  const venv = path.join(process.cwd(), "scripts", "ml", ".venv");
  const venvPython =
    process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  return existsSync(venvPython) ? venvPython : "python";
}

function python(args: string[], job: TrainingJob): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), args, { cwd: process.cwd(), windowsHide: true });
    const timer = setTimeout(() => {
      push(job, `timed out after ${TIMEOUT_MS / 60_000} minutes`);
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => push(job, b.toString()));
    child.stderr.on("data", (b: Buffer) => push(job, b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start python: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
