import type { z } from "zod";

export interface ValidationIssue {
  /** Dotted path to the offending field; empty for the root. */
  path: string;
  message: string;
}

/** Flattens zod issues into { path, message } pairs for errors and logs. */
export function formatIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/** safeParse with flattened issues. */
export function validate<S extends z.ZodType>(schema: S, input: unknown): ValidationResult<z.output<S>> {
  const r = schema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: formatIssues(r.error) };
}

/**
 * Parses or throws the error built by `onError` — lets each layer throw its
 * own error type (e.g. ValidationError from lib/errors) from one helper.
 */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  onError: (issues: ValidationIssue[]) => Error,
): z.output<S> {
  const r = validate(schema, input);
  if (!r.ok) throw onError(r.issues);
  return r.value;
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

/** Exhaustiveness check for switch statements over unions. */
export function assertNever(v: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${JSON.stringify(v)}`);
}
