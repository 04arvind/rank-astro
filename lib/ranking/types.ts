import type { SignalName } from "@/config";
import type { FeatureVector } from "@/lib/astrologer";
import type { ExposureSnapshot } from "@/lib/analytics";
import type { AstrologerProfile } from "@/types/astrologer";
import type { ExplanationDetail, RankingContext, RankingExplanation } from "@/types/ranking";
import type { UserSignals } from "@/types/user";
import type { BanditContext } from "./bandit/policy";

/** User signals from lib/user; the engine reads them, never derives them. */
export type UserContext = UserSignals;

/** Live marketplace balance per provider. */
export interface ProviderState {
  providerId: string;
  /** Target share renormalized over providers that have eligible astrologers. */
  targetShare: number;
  configuredTargetShare: number;
  /** Smoothed observed share of recent top-N exposure. */
  actualShare: number;
  /** targetShare − actualShare; positive = under-exposed. */
  gap: number;
  /** utilizationScore: occupied supply / available supply (null = unknown). */
  utilization: number | null;
  /** Capacity usage above config.providers.utilization.saturationThreshold. */
  saturated: boolean;
  /** Live supply from astrologer statuses: busy (occupied) and online + busy (available). */
  occupiedSupply: number;
  availableSupply: number;
  /** busy / (online + busy), when enough statuses are known. */
  liveUtilization: number | null;
  /** Call-minutes / capacity from recorded calls. */
  historicalUtilization: number | null;
  /** Tracked over config.providers.performance.windowHours. */
  impressions: number;
  completedCalls: number;
  /** Impression → completed call, smoothed toward the platform rate. */
  conversionRate: number;
  /** conversionRate / platform rate (1 = average). */
  efficiency: number;
}

/** Shared, request-level inputs every component and adjustment may read. */
export interface SignalContext {
  ctx: RankingContext;
  user: UserContext;
  providers: ReadonlyMap<string, ProviderState>;
  exposure: ExposureSnapshot;
  now: number;
  /** Fraction of the current quota period elapsed (0..1). */
  periodElapsed: number;
  /** Total impressions across candidates — for exploration's uncertainty bonus. */
  totalImpressions: number;
  candidateCount: number;
  /** Layer-3 Thompson samples (lib/ranking/bandit); set on the run's context after re-ranking, absent when off or failed. */
  bandit?: BanditContext;
}

export interface SignalInput {
  astrologer: AstrologerProfile;
  features: FeatureVector;
}

export type ReasonAudience = "user" | "internal";

export interface SignalResult {
  /** Normalized 0..1, or null when the input is unknown or not applicable. */
  value: number | null;
  /** Plain-language explanation, when worth stating. */
  reason?: string;
  detail?: ExplanationDetail;
}

/** One normalized component of a composite score. */
export interface Signal {
  name: SignalName;
  /** Who may see this component's reason: users, or internal/admin only. */
  audience: ReasonAudience;
  compute(input: SignalInput, sctx: SignalContext): SignalResult;
}

export interface ScoredCandidate {
  astrologer: AstrologerProfile;
  features: FeatureVector;
  /** Current finalScore (updated by re-ranking stages that add diversity). */
  score: number;
  explanation: RankingExplanation;
  scorer: string;
}

/** Why an astrologer's final position differs from pure score order. */
export interface RerankAdjustment {
  stage: "diversity" | "exploration" | "guardrail" | "bandit" | "ml" | "final" | "premium";
  note: string;
}

export interface RankedCandidate extends ScoredCandidate {
  rank: number;
  /** Position by score alone, before diversity/exploration. */
  scoreRank: number;
  adjustments: RerankAdjustment[];
  isExploration: boolean;
  /** Position after diversity, exploration and the learned ranker, before Thompson sampling. */
  layer2Rank?: number;
  /**
   * Score the learned ranker (Layer 4) ordered by, in `score` units; set only
   * when it re-ordered the list. Thompson sampling centres its prior on it.
   */
  orderScore?: number;
  /** Holds a reserved position: a premium slot (1–2) or a Thompson slot (3–4). Layer 6 never moves it. */
  slot?: "premium" | "bandit";
  /** Layer-4 model output for this candidate (live or shadow). */
  ml?: { score: number; rescaled: number; orderScore: number; model: string };
}
