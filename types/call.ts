export type CallStatus = "completed" | "missed" | "rejected" | "failed";

/** One consultation, recorded once it has ended. */
export interface CallRecord {
  callId: string;
  userId: string;
  astrologerId: string;
  providerId: string;
  status: CallStatus;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms; equals startedAt for calls that never connected. */
  endedAt: number;
  durationSeconds: number;
  pricePerMinute: number;
  /** Amount billed to the user (currency units). */
  grossAmount: number;
  /** Ranking request that led to this call, for attribution. */
  requestId?: string;
}
