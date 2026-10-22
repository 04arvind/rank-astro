import type { CallRecord } from "./call";

/*
 * Events: raw facts written by the app.
 * All timestamps are epoch milliseconds.
 */

interface BaseEvent {
  eventId: string;
  timestamp: number;
  sessionId?: string;
  userId?: string;
}

export interface ImpressionEvent extends BaseEvent {
  type: "impression";
  astrologerId: string;
  providerId: string;
  /** 1-based position in the ranked list. */
  position: number;
  requestId?: string;
  engineVersion?: string;
  category?: string;
  /** Where it was shown, e.g. a home-feed column id. */
  placement?: string;
}

export interface ClickEvent extends BaseEvent {
  type: "click";
  astrologerId: string;
  providerId: string;
  position?: number;
  requestId?: string;
  placement?: string;
}

export interface CallEvent extends BaseEvent, CallRecord {
  type: "call";
  userId: string;
}

export interface RatingEvent extends BaseEvent {
  type: "rating";
  callId: string;
  userId: string;
  astrologerId: string;
  providerId: string;
  /** 1..5 */
  rating: number;
  complaint: boolean;
}

export type AnalyticsEvent = ImpressionEvent | ClickEvent | CallEvent | RatingEvent;
export type AnalyticsEventType = AnalyticsEvent["type"];

export type { TimeRange } from "@/lib/utils/time";

/*
 * Metrics: observed facts derived from events. Rates are null when the
 * denominator is zero — interpreting sparse data (priors, smoothing) is the
 * ranking engine's job, not analytics'.
 */

export interface AstrologerMetrics {
  astrologerId: string;
  providerId: string;
  impressions: number;
  clicks: number;
  calls: number;
  completedCalls: number;
  missedCalls: number;
  totalCallSeconds: number;
  grossRevenue: number;
  uniqueCallers: number;
  /** Completed calls from users who had already completed a call with this astrologer. */
  repeatCalls: number;
  ratingCount: number;
  ratingSum: number;
  complaints: number;
  // Observed rates
  ctr: number | null;
  /** completedCalls / clicks; can exceed 1 until calls are attributed to clicks */
  clickToCallRate: number | null;
  /** completedCalls / impressions */
  conversionRate: number | null;
  /** completedCalls / (completedCalls + missedCalls); technical failures excluded */
  responseRate: number | null;
  repeatRate: number | null;
  avgCallSeconds: number | null;
  avgRating: number | null;
  complaintRate: number | null;
  revenuePerImpression: number | null;
}

export interface ProviderMetrics {
  providerId: string;
  impressions: number;
  /** Impressions within the top-N slots used for exposure share. */
  topNImpressions: number;
  clicks: number;
  calls: number;
  completedCalls: number;
  grossRevenue: number;
  /** Platform's cut of grossRevenue per provider revenue share. */
  platformRevenue: number;
  exposureShare: number;
  targetShare?: number;
  capacity?: number;
  /** Call-minutes used / (capacity × window minutes), 0..1. */
  avgUtilization: number | null;
  /** Highest concurrent calls / capacity observed in the window. */
  peakUtilization: number | null;
  ctr: number | null;
  conversionRate: number | null;
}

export interface UserAstrologerHistory {
  astrologerId: string;
  providerId: string;
  completedCalls: number;
  totalCallSeconds: number;
  totalSpend: number;
  lastCallAt: number;
  avgPricePerMinute: number;
}

export interface UserCallSummary {
  userId: string;
  completedCalls: number;
  totalSpend: number;
  avgPricePerMinute: number | null;
  astrologers: UserAstrologerHistory[];
}
