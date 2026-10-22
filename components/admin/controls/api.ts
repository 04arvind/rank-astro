import type { previewOf } from "@/app/api/_lib/adminImport";
import type { AdminAstrologerRow, DatabaseOverview, ImportRecordDoc, ProviderSummary } from "@/db/adminStore";

/* Thin client for the /api/admin/* routes used by the dashboard controls. */

export type ImportPreview = ReturnType<typeof previewOf>;
export type ImportResult = ImportPreview & { record: ImportRecordDoc };
export type { AdminAstrologerRow, DatabaseOverview, ImportRecordDoc, ProviderSummary };

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { "content-type": "application/json", ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; error: { message: string; details?: { issues?: { path: string; message: string }[] } } }
    | null;
  if (!body) throw new ApiFailure(`Request failed (HTTP ${res.status})`);
  if (!body.success) throw new ApiFailure(body.error.message, body.error.details?.issues ?? []);
  return body.data;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const fmtDate = (ms?: number | null) => (ms ? new Date(ms).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const inr = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `₹${Math.round(n * 100) / 100}`);
