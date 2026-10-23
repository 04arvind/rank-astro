import type { ValidationIssue } from "@/lib/utils/validation";

/*
 * Centralized error model.
 *
 * Every error has two faces:
 *  - internal: `message`, `details`, `cause` — for logs only, may name
 *    providers, files, upstream status codes, row numbers;
 *  - public:   `code`, `publicMessage`, `publicDetails` — the only parts
 *    that ever reach an API response.
 *
 * Throw the most specific subclass; the API layer turns any error into a safe
 * response with toPublicError() and records the full picture with logError().
 */

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

interface CodeSpec {
  status: number;
  /** Default user-safe message. */
  message: string;
  /** Worth retrying later (sets Retry-After on the response). */
  retryable?: boolean;
}

export const ERROR_CODES = {
  // Request / API
  VALIDATION_ERROR: { status: 400, message: "Request validation failed" },
  INVALID_JSON: { status: 400, message: "Request body is not valid JSON" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "You don't have access to this resource" },
  NOT_FOUND: { status: 404, message: "Resource not found" },
  PAYLOAD_TOO_LARGE: { status: 413, message: "Request body is too large" },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Content-Type must be application/json" },
  RATE_LIMITED: { status: 429, message: "Too many requests. Please slow down.", retryable: true },

  // Domain
  INVALID_ASTROLOGER_DATA: { status: 422, message: "Some astrologer data could not be processed" },
  ASTROLOGER_NOT_ELIGIBLE: { status: 422, message: "This astrologer isn't available right now" },
  SLOT_UNAVAILABLE: { status: 409, message: "That time slot is no longer available. Please pick another." },
  BOOKING_LIMIT_REACHED: { status: 422, message: "You have too many upcoming calls booked" },
  ACTIVE_BOOKING_EXISTS: { status: 409, message: "You already have a call booked" },
  NO_ASTROLOGER_AVAILABLE: { status: 409, message: "No astrologer available right now" },
  BOOKING_NOT_CHANGEABLE: { status: 409, message: "This booking can't be changed any more" },
  PAYMENT_IN_PROGRESS: { status: 409, message: "Your payment is already being used for a booking. Please wait a moment." },
  PAYMENT_NOT_USABLE: { status: 409, message: "This payment can't be used for this booking" },

  // Dependencies
  PROVIDER_UNAVAILABLE: { status: 503, message: "A partner service is temporarily unavailable. Please try again.", retryable: true },
  PROVIDER_TIMEOUT: { status: 504, message: "A partner service took too long to respond. Please try again.", retryable: true },
  PROVIDER_FEED_ERROR: { status: 502, message: "Astrologer data is temporarily unavailable" },
  DATABASE_UNAVAILABLE: { status: 503, message: "Service temporarily unavailable. Please try again.", retryable: true },

  // Engine / server
  RANKING_FAILED: { status: 500, message: "We couldn't load astrologers right now. Please try again.", retryable: true },
  NOT_IMPLEMENTED: { status: 501, message: "This feature isn't available yet" },
  SERVICE_DISABLED: { status: 503, message: "This service is not enabled" },
  CONFIGURATION_ERROR: { status: 500, message: "Internal server error" },
  INTERNAL_ERROR: { status: 500, message: "Internal server error" },
} as const satisfies Record<string, CodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export interface AppErrorOptions {
  /** Internal context for logs. Never sent to clients. */
  details?: Record<string, unknown>;
  /** Client-safe extra data (validation issues, reason codes). */
  publicDetails?: unknown;
  /** Overrides the code's default user-facing message. */
  publicMessage?: string;
  cause?: unknown;
}

/*
 * Marks AppErrors across copies of this module. Next.js bundles
 * instrumentation.ts (which installs the DB stores, db/) separately from
 * the routes, so a store can throw an AppError from another copy of this
 * file, and a plain `instanceof` would turn it into a 500. Symbol.for is
 * shared by every copy.
 */
const APP_ERROR = Symbol.for("rank-astro.AppError");
const isBranded = (value: unknown): value is AppError => typeof value === "object" && value !== null && APP_ERROR in value;
const nativeInstanceOf = (cls: object, value: unknown) => Function.prototype[Symbol.hasInstance].call(cls, value);

export class AppError extends Error {
  /** `instanceof AppError` also matches AppErrors from another copy of this module. Subclasses keep plain instanceof unless they say otherwise. */
  static [Symbol.hasInstance](value: unknown): boolean {
    return nativeInstanceOf(this, value) || (this === AppError && isBranded(value));
  }

  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly publicMessage: string;
  readonly publicDetails?: unknown;
  readonly details?: Record<string, unknown>;

  /** `message` is internal — it's logged, not returned. */
  constructor(code: ErrorCode, message: string = ERROR_CODES[code].message, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    const spec: CodeSpec = ERROR_CODES[code];
    this.name = new.target.name;
    this.code = code;
    this.status = spec.status;
    this.retryable = spec.retryable ?? false;
    this.publicMessage = options.publicMessage ?? spec.message;
    this.publicDetails = options.publicDetails;
    this.details = options.details;
    Object.defineProperty(this, APP_ERROR, { value: true });
  }
}

// ---------------------------------------------------------------------------
// Request / API errors
// ---------------------------------------------------------------------------

/** Input failed schema validation. Issues (field paths + messages) are safe to return. */
export class ValidationError extends AppError {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[] = [], options: Omit<AppErrorOptions, "publicDetails"> = {}) {
    const safe = issues.slice(0, 50).map((i) => ({ path: i.path, message: i.message.slice(0, 200) }));
    super("VALIDATION_ERROR", message, { ...options, publicMessage: options.publicMessage ?? message, publicDetails: { issues: safe } });
    this.issues = safe;
  }
}

type ApiErrorCode =
  | "INVALID_JSON"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "SERVICE_DISABLED";

/** Transport-level failures raised by the API layer itself. */
export class ApiError extends AppError {
  constructor(code: ApiErrorCode, publicMessage?: string, options: Omit<AppErrorOptions, "publicMessage"> = {}) {
    super(code, publicMessage ?? ERROR_CODES[code].message, { ...options, publicMessage });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super("NOT_FOUND", `${resource} not found${id ? `: ${id}` : ""}`, {
      publicMessage: `${resource} not found`,
      details: { resource, id },
    });
  }
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/** A provider record couldn't be mapped onto the common astrologer model. */
export class InvalidAstrologerDataError extends AppError {
  constructor(
    message: string,
    context: { providerId?: string; ref?: string; issues?: ValidationIssue[] } = {},
    options: AppErrorOptions = {},
  ) {
    // Provider, row reference and field issues stay internal.
    super("INVALID_ASTROLOGER_DATA", message, { ...options, details: { ...context, ...options.details } });
  }
}

/** An astrologer failed hard eligibility rules. Reason codes are safe to expose. */
export class EligibilityError extends AppError {
  readonly reasons: string[];

  constructor(astrologerId: string, reasons: string[], options: AppErrorOptions = {}) {
    super("ASTROLOGER_NOT_ELIGIBLE", `Astrologer ${astrologerId} not eligible: ${reasons.join(", ")}`, {
      ...options,
      details: { astrologerId, reasons, ...options.details },
      publicDetails: { reasons },
    });
    this.reasons = reasons;
  }
}

export type SlotUnavailableReason = "astrologer_busy" | "user_busy" | "outside_schedule";

/** A booking asked for a slot that can't be taken. The reason code is safe to expose. */
export class SlotUnavailableError extends AppError {
  /** Also matches one thrown by another copy of this module (the DB booking store), so busy-slot handling works there too. */
  static [Symbol.hasInstance](value: unknown): boolean {
    return nativeInstanceOf(this, value) || (this === SlotUnavailableError && isBranded(value) && value.code === "SLOT_UNAVAILABLE" && "reason" in value);
  }

  readonly reason: SlotUnavailableReason;

  constructor(reason: SlotUnavailableReason, context: { astrologerId: string; startAt: number }, options: AppErrorOptions = {}) {
    super("SLOT_UNAVAILABLE", `Slot ${context.startAt} for ${context.astrologerId} unavailable: ${reason}`, {
      ...options,
      publicMessage:
        reason === "user_busy"
          ? "You already have a call booked at this time."
          : reason === "outside_schedule"
            ? "That time can't be booked. Please pick a slot from the calendar."
            : undefined,
      details: { ...context, reason, ...options.details },
      publicDetails: { reason },
    });
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

export interface ProviderErrorContext {
  providerId: string;
  operation: string;
  /** Upstream HTTP status, if any. */
  upstreamStatus?: number;
  [key: string]: unknown;
}

/** A third-party provider call failed. Provider identity never reaches users. */
export class ProviderError extends AppError {
  readonly providerId: string;

  constructor(message: string, context: ProviderErrorContext, options: AppErrorOptions = {}) {
    super("PROVIDER_UNAVAILABLE", message, { ...options, details: { ...context, ...options.details } });
    this.providerId = context.providerId;
  }
}

export class ProviderTimeoutError extends AppError {
  readonly providerId: string;

  constructor(context: ProviderErrorContext & { timeoutMs: number }, options: AppErrorOptions = {}) {
    super("PROVIDER_TIMEOUT", `${context.providerId} ${context.operation} timed out after ${context.timeoutMs}ms`, {
      ...options,
      details: { ...context, ...options.details },
    });
    this.providerId = context.providerId;
  }
}

/** A database operation failed or the database is unreachable. */
export class DatabaseError extends AppError {
  constructor(message: string, context: { operation: string; collection?: string }, options: AppErrorOptions = {}) {
    super("DATABASE_UNAVAILABLE", message, { ...options, details: { ...context, ...options.details } });
  }
}

/** A provider feed file is missing, unreadable or malformed. */
export class ProviderFeedError extends AppError {
  readonly providerId: string;

  constructor(message: string, context: { providerId: string; file?: string; format?: string }, options: AppErrorOptions = {}) {
    super("PROVIDER_FEED_ERROR", message, { ...options, details: { ...context, ...options.details } });
    this.providerId = context.providerId;
  }
}

// ---------------------------------------------------------------------------
// Engine / server errors
// ---------------------------------------------------------------------------

export type RankingStage =
  | "load"
  | "availability"
  | "metrics"
  | "user"
  | "providers"
  | "candidates"
  | "features"
  | "bandit"
  | "scoring"
  | "rerank"
  | "ml"
  | "final";

/** The ranking pipeline failed at a given stage. */
export class RankingError extends AppError {
  readonly stage: RankingStage;

  constructor(stage: RankingStage, message: string, options: AppErrorOptions = {}) {
    super("RANKING_FAILED", `Ranking failed at ${stage}: ${message}`, {
      ...options,
      details: { stage, ...options.details },
    });
    this.stage = stage;
  }
}

export class NotImplementedError extends AppError {
  constructor(feature: string) {
    super("NOT_IMPLEMENTED", `${feature} is not implemented`);
  }
}

/** Misconfiguration (missing adapter, bad config). A bug to fix, not a user error. */
export class ConfigurationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFIGURATION_ERROR", message, { details });
  }
}

export class InternalError extends AppError {
  constructor(message = "Unexpected error", options: AppErrorOptions = {}) {
    super("INTERNAL_ERROR", message, options);
  }
}

// ---------------------------------------------------------------------------
// Handling utilities
// ---------------------------------------------------------------------------

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Normalizes anything thrown into an AppError (unknown errors become INTERNAL_ERROR). */
export function toAppError(err: unknown, fallback: (cause: unknown) => AppError = (c) => new InternalError(messageOf(c), { cause: c })): AppError {
  if (isAppError(err)) return err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new InternalError(`Operation aborted: ${err.message}`, { cause: err });
  }
  return fallback(err);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface PublicError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/** The only representation of an error that may be sent to a client. */
export function toPublicError(err: unknown): PublicError {
  const e = toAppError(err);
  return e.publicDetails === undefined
    ? { code: e.code, message: e.publicMessage }
    : { code: e.code, message: e.publicMessage, details: e.publicDetails };
}

export function httpStatusOf(err: unknown): number {
  return toAppError(err).status;
}

// ---------------------------------------------------------------------------
// Logging with redaction
// ---------------------------------------------------------------------------

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|phone|mobile|contact|email/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g;
const PHONE = /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)/g;
const BEARER = /bearer\s+[\w.~+/-]+=*/gi;

/** Deep-copies a value, masking sensitive keys and PII-looking strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    return value.replace(EMAIL, "[email]").replace(PHONE, "[phone]").replace(BEARER, "Bearer [redacted]").slice(0, 2000);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  return value;
}

export interface LogContext {
  /** Where it happened, e.g. "api", "providers". */
  scope: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Logs the full internal picture — code, internal message, details, cause
 * chain — with secrets and PII redacted. Client errors log as warnings.
 */
export function logError(err: unknown, context: LogContext): void {
  const e = toAppError(err);
  const causes: unknown[] = [];
  for (let c = e.cause, i = 0; c !== undefined && i < 5; c = (c as { cause?: unknown })?.cause, i++) {
    causes.push(c instanceof Error ? { name: c.name, message: c.message } : c);
  }

  const entry = redact({
    ...context,
    code: e.code,
    status: e.status,
    message: e.message,
    details: e.details,
    causes: causes.length ? causes : undefined,
  });
  const line = `[${context.scope}]${context.requestId ? ` ${context.requestId}` : ""} ${e.code}: ${redact(e.message)}`;
  if (e.status >= 500) console.error(line, entry);
  else console.warn(line, entry);
}
