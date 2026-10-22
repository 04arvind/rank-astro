import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { logError, toAppError } from "@/lib/errors";

/*
 * Shared plumbing for dev scripts: argument parsing, a safe main() wrapper,
 * file output under the project, and a seeded RNG. No business logic.
 */

export const ROOT = process.cwd();
export const REPORTS_DIR = path.join(ROOT, "reports");

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Parses --flags; prints usage and exits on --help or unknown flags. */
export function args<O extends Options>(usage: string, options: O) {
  try {
    const { values } = parseArgs({ options: { ...options, help: { type: "boolean", short: "h" } }, strict: true });
    if ((values as { help?: boolean }).help) {
      console.log(usage.trim());
      process.exit(0);
    }
    return values as ReturnType<typeof parseArgs<{ options: O; strict: true }>>["values"];
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${usage.trim()}`);
    process.exit(2);
  }
}

/** Runs a script, turning any failure into a logged error and exit code 1. */
export function main(name: string, fn: () => Promise<number | void>): void {
  const started = Date.now();
  fn()
    .then((code) => {
      console.log(`\n✔ ${name} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      process.exitCode = code ?? 0;
    })
    .catch((err) => {
      const e = toAppError(err);
      logError(e, { scope: `script:${name}` });
      console.error(`\n✖ ${name} failed: ${e.message}`);
      process.exitCode = 1;
    });
}

/**
 * Writes a file inside the project, creating directories; refuses paths
 * outside it. Writes to a temp file and renames, so readers never see a
 * half-written file.
 */
export async function writeProjectFile(file: string, contents: string): Promise<string> {
  const abs = path.resolve(ROOT, file);
  if (!abs.startsWith(ROOT + path.sep)) throw new Error(`Refusing to write outside the project: ${file}`);
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, abs);
  return path.relative(ROOT, abs);
}

export const writeJson = (file: string, data: unknown) => writeProjectFile(file, `${JSON.stringify(data, null, 2)}\n`);

/** Filesystem-safe timestamp, e.g. 2026-09-29T10-15-00. */
export function stamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/:/g, "-");
}

export function heading(text: string): void {
  console.log(`\n${text}\n${"─".repeat(Math.min(text.length, 80))}`);
}

export const pct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

/** mulberry32 — small, fast, seeded PRNG so simulations are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(items: readonly T[], r: () => number): T {
  return items[Math.floor(r() * items.length)];
}

export function intArg(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer (got "${v}")`);
  return n;
}
