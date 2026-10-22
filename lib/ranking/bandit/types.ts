/*
 * Thompson-sampling state for User-Choice ranking. Everything here is
 * persisted (MongoDB in production, see db/banditStore.ts): the posterior
 * counters ("arms"), the exposure and outcome ledgers that make every
 * counter update idempotent, and the served recommendation events.
 */

export type BanditMode = "off" | "shadow" | "live";
/** "control" viewers (config holdoutShare) get the pre-bandit ranking; they still teach the model. */
export type BanditVariant = "treatment" | "control";
export type BanditSurface = "rank" | "feed";

/** Context of an arm that learns across every request. */
export const ANY_CONTEXT = "*";

/**
 * Beta posterior counters. Astrologer arms exist per context (the request's
 * category) and overall; provider arms pool every astrologer of a provider
 * and set the prior for that provider's new astrologers.
 */
export interface ArmStats {
  id: string;
  policy: string;
  kind: "astrologer" | "provider";
  context: string;
  astrologerId?: string;
  providerId: string;
  /** Position-weighted exposures (each ≤ 1). */
  trials: number;
  /** Attributed completed consultations. */
  successes: number;
  /** ₹ billed and platform margin of those consultations. */
  revenue: number;
  margin: number;
  updatedAt: number;
}

export type ArmIncrement = Omit<ArmStats, "trials" | "successes" | "revenue" | "margin" | "updatedAt"> &
  Partial<Pick<ArmStats, "trials" | "successes" | "revenue" | "margin">>;

/** One viewer seeing one astrologer in one context, deduplicated per exposureDedupHours. */
export interface ExposureRecord {
  /** policy|context|viewerKey|astrologerId|bucket */
  id: string;
  policy: string;
  viewerKey: string;
  userId?: string;
  sessionId?: string;
  astrologerId: string;
  providerId: string;
  context: string;
  variant: BanditVariant;
  mode: BanditMode;
  surface: BanditSurface;
  requestId?: string;
  placement?: string;
  /** Best (lowest) position this viewer saw the astrologer at in the window. */
  position: number;
  /** Trial weight counted for this exposure (from its first position). */
  weight: number;
  firstAt: number;
  lastAt: number;
  sample: number | null;
  posteriorMean: number | null;
  /** The booking this exposure was credited with; one success per exposure at most. */
  convertedBy: string | null;
}

export type OutcomeStatus = "pending" | "applied" | "unattributed";

/** One completed User-Choice consultation, keyed by bookingId: processed once. */
export interface OutcomeRecord {
  bookingId: string;
  policy: string;
  status: OutcomeStatus;
  astrologerId: string;
  providerId: string;
  userId: string;
  sessionId?: string;
  exposureId?: string;
  context?: string;
  variant?: BanditVariant;
  requestId?: string;
  revenue: number;
  margin: number;
  bookedAt: number;
  completedAt: number;
  processedAt: number;
}

export interface RecommendationItem {
  astrologerId: string;
  providerId: string;
  position: number;
  placement?: string;
  sample: number | null;
  posteriorMean: number | null;
  /** The objective value the slot was decided by. */
  reward: number | null;
  /** Layer-2 position (before Thompson sampling); `position` is what was shown. */
  layer2Rank: number | null;
}

/** One served User-Choice list, as the bandit saw it. */
export interface RecommendationEvent {
  /** The API requestId. */
  id: string;
  policy: string;
  surface: BanditSurface;
  viewerKey: string;
  userId?: string;
  sessionId?: string;
  variant: BanditVariant;
  mode: BanditMode;
  context: string;
  at: number;
  items: RecommendationItem[];
}

export interface VariantSummary {
  variant: BanditVariant;
  exposures: number;
  weightedExposures: number;
  completions: number;
  revenue: number;
  margin: number;
}

export interface ProviderSummary {
  providerId: string;
  exposures: number;
  weightedExposures: number;
  completions: number;
  margin: number;
}

export interface BanditSummary {
  variants: VariantSummary[];
  providers: ProviderSummary[];
  outcomes: Record<OutcomeStatus, number>;
}

/**
 * Persistence boundary. Implementations must make `recordExposures`,
 * `claimOutcome` and `convertExposure` atomic per record — they are what
 * keeps concurrent requests and retried reconciliations from counting twice.
 */
export interface BanditStore {
  getArms(ids: readonly string[]): Promise<ArmStats[]>;
  /** $inc-style, upserting missing arms. */
  incrementArms(updates: readonly ArmIncrement[], now: number): Promise<void>;
  /** Upserts exposures; returns only those that were new (the rest just get lastAt / best position refreshed). */
  recordExposures(exposures: readonly ExposureRecord[]): Promise<ExposureRecord[]>;
  appendRecommendation(event: RecommendationEvent): Promise<void>;
  /**
   * Inserts a pending outcome. False when the booking is already claimed —
   * unless that claim is still pending and older than `staleBefore` (its
   * worker died), in which case it is taken over (compare-and-set).
   */
  claimOutcome(outcome: OutcomeRecord, staleBefore: number): Promise<boolean>;
  /** Applies `patch` only while the outcome is still pending; false otherwise. */
  finishOutcome(bookingId: string, patch: Partial<OutcomeRecord>): Promise<boolean>;
  /**
   * Credits `bookingId` to the viewer's most recent exposure of the
   * astrologer that started by `to` and was last seen at or after `from`,
   * and isn't credited to another booking (re-running for the same booking
   * finds the same exposure); null when none.
   */
  convertExposure(q: { policy: string; viewerKeys: readonly string[]; astrologerId: string; from: number; to: number; bookingId: string }): Promise<ExposureRecord | null>;
  getMeta<T>(key: string): Promise<T | null>;
  setMeta<T>(key: string, value: T): Promise<void>;
  /** Takes (or renews) a named lease until `until`; false while someone else holds it. */
  tryLease(name: string, owner: string, until: number, now: number): Promise<boolean>;
  releaseLease(name: string, owner: string): Promise<void>;
  /** Recomputes every arm of `policy` from the exposure and outcome ledgers. */
  rebuildArms(policy: string, now: number): Promise<number>;
  summarize(policy: string, since: number): Promise<BanditSummary>;
  topArms(policy: string, limit: number): Promise<ArmStats[]>;
}
