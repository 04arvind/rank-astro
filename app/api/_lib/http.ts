import type { NextRequest } from "next/server";
import { logError, toAppError, toPublicError, type PublicError } from "@/lib/errors";

export interface ApiMeta {
  requestId: string;
  [key: string]: unknown;
}

export type ApiSuccess<T> = { success: true; data: T; meta: ApiMeta };
export type ApiFailure = {
  success: false;
  error: PublicError;
  meta: ApiMeta;
};

export function ok<T>(
  data: T,
  meta: ApiMeta,
  init?: { status?: number; headers?: HeadersInit },
): Response {
  const body: ApiSuccess<T> = { success: true, data, meta };
  return Response.json(body, withRequestId(meta.requestId, init));
}

export function fail(
  status: number,
  error: PublicError,
  meta: ApiMeta,
  headers?: HeadersInit,
): Response {
  const body: ApiFailure = { success: false, error, meta };
  return Response.json(body, withRequestId(meta.requestId, { status, headers }));
}

function withRequestId(
  requestId: string,
  init?: { status?: number; headers?: HeadersInit },
): ResponseInit {
  const headers = new Headers(init?.headers);
  headers.set("x-request-id", requestId);
  headers.set("cache-control", "no-store");
  return { status: init?.status ?? 200, headers };
}

/**
 * Any thrown value → safe JSON error. Only the public face of the error
 * (code, public message, public details) is returned; the internal message,
 * details and cause are logged with redaction.
 */
function toFailure(err: unknown, meta: ApiMeta, route: string): Response {
  const e = toAppError(err);
  logError(e, { scope: "api", requestId: meta.requestId, route });
  return fail(e.status, toPublicError(e), meta, e.retryable ? { "retry-after": "5" } : undefined);
}

/** Accept a caller's request id only if it's a short, safe token. */
function requestIdFrom(req: NextRequest): string {
  const incoming = req.headers.get("x-request-id");
  return incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
}

export interface HandlerContext {
  requestId: string;
}

/**
 * Wraps a route handler with request-id propagation and uniform error mapping,
 * so individual routes only contain orchestration.
 */
export function handle(
  fn: (req: NextRequest, ctx: HandlerContext) => Promise<Response>,
) {
  return async (req: NextRequest): Promise<Response> => {
    const requestId = requestIdFrom(req);
    try {
      return await fn(req, { requestId });
    } catch (err) {
      return toFailure(err, { requestId }, `${req.method} ${req.nextUrl.pathname}`);
    }
  };
}
