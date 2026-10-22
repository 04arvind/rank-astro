/*
 * Lenient parsing of untrusted input (CSV cells, query strings, JSON).
 * Every function returns undefined instead of throwing.
 */

/** Trimmed non-empty string, or undefined. */
export function toText(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** First number in a value: "₹1,500" → 1500, "30 min" → 30, 42 → 42. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = toText(v);
  if (s === undefined) return undefined;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

export function toInt(v: unknown): number | undefined {
  const n = toNumber(v);
  return n === undefined ? undefined : Math.trunc(n);
}

const TRUE = new Set(["true", "yes", "y", "1", "on"]);
const FALSE = new Set(["false", "no", "n", "0", "off"]);

export function toBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = toText(v)?.toLowerCase();
  if (s === undefined) return undefined;
  return TRUE.has(s) ? true : FALSE.has(s) ? false : undefined;
}

/** Splits on the given separators; trims and drops empty items. */
export function toList(v: unknown, separators: RegExp = /[,;]/): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => toText(x)).filter((x): x is string => x !== undefined);
  const s = toText(v);
  return s === undefined ? undefined : s.split(separators).map((x) => x.trim()).filter(Boolean);
}

/** Epoch ms from a number or a parseable date string. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = toText(v);
  if (s === undefined) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** An absolute http(s) URL, normalized, or undefined. */
export function toHttpUrl(v: unknown): string | undefined {
  const s = toText(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Last non-empty path segment of a URL. */
export function lastPathSegment(v: unknown): string | undefined {
  const url = toHttpUrl(v);
  return url ? new URL(url).pathname.split("/").filter(Boolean).pop() : undefined;
}

/** Lowercase ASCII kebab-case; strips accents and symbols. */
export function slugify(v: string): string {
  return v
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function safeJsonParse<T = unknown>(text: string): { ok: true; value: T } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}

/** Reads a dotted path ("a.b.0.c") from a nested value. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
