import type { NextRequest } from "next/server";
import { z } from "zod";
import { safeJsonParse } from "@/lib/utils/parse";
import { ApiError, ValidationError } from "@/lib/errors";
import { parseOrThrow, type ValidationIssue } from "@/lib/utils/validation";

const MAX_BODY_BYTES = 64 * 1024;

const validationError = (issues: ValidationIssue[]) => new ValidationError("Request validation failed", issues);

export async function parseJsonBody<S extends z.ZodType>(
  req: NextRequest,
  schema: S,
): Promise<z.output<S>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE");
  }

  const tooLarge = new ApiError("PAYLOAD_TOO_LARGE", `Request body must be at most ${MAX_BODY_BYTES / 1024} KB`);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw tooLarge;

  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw tooLarge;

  const parsed = raw.length === 0 ? { ok: true as const, value: {} } : safeJsonParse(raw);
  if (!parsed.ok) throw new ApiError("INVALID_JSON", undefined, { cause: parsed.error });
  const json = parsed.value;

  return parseOrThrow(schema, json, validationError);
}

/**
 * Parses query params. Repeated keys (`?lang=hi&lang=en`) and comma lists
 * (`?lang=hi,en`) both become arrays; single values stay strings.
 */
export function parseQuery<S extends z.ZodType>(
  req: NextRequest,
  schema: S,
): z.output<S> {
  const params = req.nextUrl.searchParams;
  const obj: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key).flatMap((v) => v.split(",")).filter(Boolean);
    obj[key] = values.length === 1 ? values[0] : values;
  }

  return parseOrThrow(schema, obj, validationError);
}
