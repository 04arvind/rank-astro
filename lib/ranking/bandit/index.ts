/**
 * Layer 3 — Thompson sampling for User-Choice lists (the user picks an
 * astrologer): re-assigns the top slots of the Layer-2 ranking and learns
 * from attributed completed consultations. Never part of any score.
 * First-Out round-robin allocation never uses it.
 */
export { thompsonRerank } from "./rerank";
export { loadBanditState, resolveMode, resetBanditCache, setModeFlag, variantOf, viewerKeyOf, type BanditContext, type BanditDecision, type BanditState, type ModeResolution } from "./policy";
export { posteriorFor, contextKeyOf, marginRateOf, expectedMarginPerConsultation, type Posterior } from "./posterior";
export {
  isCompletedUserChoice,
  maybeReconcile,
  positionWeight,
  rebuildArms,
  reconcileOutcomes,
  recordServed,
  type ReconcileResult,
  type ServedItem,
} from "./learning";
export { getBanditReport, type BanditReport } from "./report";
export { getBanditStore, setBanditStore, InMemoryBanditStore } from "./store";
export * from "./types";
