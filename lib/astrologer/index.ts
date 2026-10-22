/**
 * Astrologer data processing: provider feeds → common model → eligible
 * candidates → feature vectors. Scoring and ordering live in lib/ranking.
 */
export { normalizeFeeds, normalizeProviderFeed, toPublicAstrologer } from "./normalize";
export type { NormalizationResult, NormalizeOptions, RejectedRecord } from "./normalize";
export { assertValidAstrologer, astrologerProfileSchema, validateAstrologer } from "./validation";
export { assertEligible, checkEligibility, type EligibilityResult, type ExclusionReason } from "./eligibility";
export { generateCandidates, type CandidateSet, type ExcludedCandidate } from "./condidate";
export {
  FEATURE_NAMES,
  prepareFeatures,
  type CandidateFeatures,
  type FeatureName,
  type FeatureVector,
} from "./features";
export {
  getAstrologerRepository,
  setAstrologerRepository,
  InMemoryAstrologerRepository,
  SnapshotAstrologerRepository,
  FeedAstrologerRepository,
  NORMALIZED_SNAPSHOT,
  type AstrologerRepository,
} from "./repository";
