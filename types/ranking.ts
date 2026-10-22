import type { ScoreName } from "@/config";
import type { Astrologer } from "./astrologer";

export type Platform = "web" | "android" | "ios";

/** Everything the engine needs to know about who is asking and in what situation. */
export interface RankingContext {
  user: {
    /** Absent for anonymous / first-time visitors. */
    userId?: string;
    sessionId?: string;
  };
  context: {
    category?: string;
    /** Specialization id (config.catalog.specializations), e.g. "tarot". */
    specialization?: string;
    languages?: string[];
    priceRange?: { min?: number; max?: number };
    platform?: Platform;
  };
  filters: {
    onlineOnly: boolean;
    providerIds?: string[];
  };
  pagination: {
    limit: number;
    offset: number;
  };
}

/** Identifies which engine produced a ranking (heuristic today, ML later). */
export interface EngineInfo {
  name: string;
  version: string;
}

export interface RankedAstrologer {
  rank: number;
  score: number;
  astrologer: Astrologer;
  /** Human-readable reasons, e.g. "Speaks Hindi", "Matches your category". */
  reasons?: string[];
}

export interface RankingResult {
  items: RankedAstrologer[];
  total: number;
  engine: EngineInfo;
}

// ---------------------------------------------------------------------------
// Score explanation — every signal, penalty, booster and the final score
// ---------------------------------------------------------------------------

export type ExplanationDetail = Record<string, number | string | null | undefined>;

/** One normalized input inside a composite score. */
export interface ComponentExplanation {
  name: string;
  /** 0..1, or null when unknown (excluded from the score's average). */
  value: number | null;
  /** Configured weight within its score. */
  weight: number;
  /** Share of finalScore contributed: scoreWeight × normalized component weight × value. */
  contribution: number;
  audience: "user" | "internal";
  reason?: string;
  detail?: ExplanationDetail;
}

export interface ScoreExplanation {
  name: ScoreName;
  /** 0..1 */
  value: number;
  /** Segment weight in baseScore. */
  weight: number;
  contribution: number;
  /** True when no component had data and the neutral value was used. */
  missing: boolean;
  components: ComponentExplanation[];
}

export type AdjustmentName = "providerBooster" | "quotaUrgencyBoost" | "frequencyPenalty";

export interface AdjustmentExplanation {
  name: AdjustmentName;
  /** Signed effect on finalScore (penalties are negative). */
  value: number;
  /** Value before bounds and gates. */
  raw: number;
  bounds: [number, number];
  applied: boolean;
  /** Why it was withheld or capped, if it was. */
  note?: string;
  inputs: ExplanationDetail;
}

export type ExtensionTermName =
  | "conversionScore"
  | "retentionScore"
  | "quotaUrgencyScore"
  | "overExposurePenalty"
  | "lowQualityPenalty"
  | "unavailablePenalty";

/** One extra signal or penalty layered on finalScore. */
export interface ExtensionTerm {
  name: ExtensionTermName;
  kind: "signal" | "penalty";
  /** Normalized 0..1 before weighting (null = unknown → contributes 0). */
  value: number | null;
  weight: number;
  /** Signed effect on totalScore (penalties are negative). */
  contribution: number;
  applied: boolean;
  /** Why it was withheld or capped, if it was. */
  note?: string;
  inputs: ExplanationDetail;
}

export interface ExtensionExplanation {
  terms: ExtensionTerm[];
  /** Σ contributions, added to finalScore to give totalScore. */
  total: number;
}

export interface RankingExplanation {
  scores: ScoreExplanation[];
  baseScore: number;
  adjustments: AdjustmentExplanation[];
  finalScore: number;
  /** finalScore + extension.total — the score candidates are ranked by. Equals finalScore when the extension is off. */
  totalScore: number;
  /** Extra signals and penalties (config.ranking.extension); absent when disabled. */
  extension?: ExtensionExplanation;
  /** All twelve headline signals at a glance (0..1; frequencyPenalty as a magnitude). */
  signals: {
    qualityScore: number;
    personalizationScore: number;
    businessScore: number;
    priceScore: number;
    categoryScore: number;
    availabilityScore: number;
    frequencyPenalty: number;
    utilizationScore: number | null;
    quotaUrgencyScore: number;
    explorationScore: number;
    languageScore: number;
    diversityScore: number;
  };
  /** The formula with this candidate's numbers filled in. */
  formula: string;
  segment: "newUser" | "returningUser";
  /** Set only when a model scorer is blended in (extension point; unused by default). */
  model?: { name: string; prediction: number; weight: number };
  /** totalScore regrouped into the Layer-2 business pillars (their contributions sum to totalScore). */
  pillars?: BusinessPillars;
}

export type BusinessPillarName =
  | "bookingProbability"
  | "profit"
  | "quality"
  | "personalization"
  | "availability"
  | "utilization"
  | "exposureFairness"
  | "model";

export interface BusinessPillar {
  /** Signed share of totalScore. */
  contribution: number;
  /** Representative 0..1 value (null when unknown or not applicable). */
  value: number | null;
  /** Which scores, components, adjustments and extension terms feed it. */
  sources: string[];
}

export type BusinessPillars = Record<BusinessPillarName, BusinessPillar>;

// ---------------------------------------------------------------------------
// Pipeline trace — the list after every layer, for the admin dashboard
// ---------------------------------------------------------------------------

export type PipelineLayerKey = "eligibility" | "business" | "candidates" | "ml" | "exploration" | "final";

export interface PipelineEntry {
  astrologerId: string;
  providerId: string;
  rank: number;
  /** The score this layer orders by (see PipelineLayer.scoreLabel); null when the layer has none. */
  score: number | null;
}

export interface PipelineFiltered {
  astrologerId: string;
  providerId: string;
  reasons: string[];
}

export interface PipelineLayer {
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  key: PipelineLayerKey;
  title: string;
  description: string;
  /** applied: changed or produced the list · passthrough: ran, kept the order · fallback: failed or gated, previous order kept. */
  status: "applied" | "passthrough" | "fallback";
  note?: string;
  durationMs: number;
  inputCount: number;
  outputCount: number;
  scoreLabel: string;
  entries: PipelineEntry[];
  /** Removed at this layer, with why. */
  filtered: PipelineFiltered[];
  details?: Record<string, string | number | boolean | null>;
}

export interface PipelineTrace {
  layers: PipelineLayer[];
  totalMs: number;
  generatedAt: string;
}

export interface RankingDebugRequest extends RankingContext {
  /** Restrict the breakdown to these astrologers; all candidates when omitted. */
  astrologerIds?: string[];
}

export interface CandidateDebug {
  astrologerId: string;
  providerId: string;
  eligible: boolean;
  exclusionReason?: string;
  finalScore: number;
  /** Per-signal contribution, keyed by signal name. */
  signals: Record<string, number>;
  /** Final position (eligible candidates only). */
  rank?: number;
  /** Position by score alone, before diversity/exploration re-ranking. */
  scoreRank?: number;
  /** Position before Layer-3 Thompson sampling (the "old" ranking); equals `rank` when the bandit didn't move it. */
  layer2Rank?: number;
  /** Public profile, for display. */
  astrologer?: Astrologer;
  /** Full score breakdown (eligible candidates only). */
  breakdown?: RankingExplanation;
  /** Re-ranking notes (diversity, exploration, guardrails). */
  adjustmentsNotes?: string[];
  isExploration?: boolean;
  /** Layer 3 (Thompson sampling) for this candidate, when it was in the sampled pool. */
  thompson?: {
    layer2Rank: number;
    sample: number;
    posteriorMean: number;
    priorMean: number;
    /** Position-weighted exposures / attributed completed consultations behind the posterior. */
    trials: number;
    successes: number;
    reward: number;
    variant: "treatment" | "control";
    mode: "shadow" | "live";
    /** Fair-exposure multiplier applied to the reward (1 = none). */
    fairness?: number;
  };
  /** Layer 4 (learned ranker), when a model scored this candidate. */
  ml?: { score: number; rescaled: number; orderScore: number; model: string };
  /** Position and score after each pipeline layer (absent where it wasn't in that layer's list). */
  layers?: Partial<Record<PipelineLayerKey, { rank: number; score: number | null }>>;
  /** Human-readable summary lines. */
  explanation?: string[];
}

export interface RankingDebugResult {
  candidates: CandidateDebug[];
  engine: EngineInfo;
  /** Layer-by-layer trace of the run. */
  pipeline?: PipelineTrace;
}

export type StatsWindow = "1h" | "24h" | "7d" | "30d";

export interface RankingStatsQuery {
  window: StatsWindow;
  providerId?: string;
}

export interface ProviderStats {
  providerId: string;
  impressions: number;
  clicks: number;
  calls: number;
  /** Share of top-N slots this provider received, 0..1. */
  exposureShare: number;
  /** Target share from provider config, 0..1. */
  targetShare?: number;
  /** Completed calls / impressions (null without impressions). */
  conversionRate?: number | null;
  /** Capacity utilization over the window: the higher of average and peak. */
  utilization?: number | null;
}

export interface RankingStats {
  window: StatsWindow;
  generatedAt: string;
  providers: ProviderStats[];
}
