/**
 * Layer 4 — learned ranking. An XGBoost LambdaMART ranker (XGBRanker,
 * rank:ndcg) trained offline by scripts/ml/train_ranker.py on logged
 * served lists, evaluated here in-process. Falls back to the Layer-3 order
 * whenever no qualified model is available.
 */
export { featureRow, ML_FEATURE_NAMES, ML_FEATURE_VERSION, type FeatureRow } from "./features";
export { parseXGBoostModel, XGBoostModelError, type XGBoostModel } from "./xgboost";
export {
  ARTIFACT_FORMAT,
  buildRanker,
  loadRanker,
  modelPath,
  rankerMode,
  resetRankerCache,
  setRankerArtifact,
  type LoadedRanker,
  type RankerArtifact,
  type RankerInfo,
  type RankerLoad,
  type RankerMode,
  type RankerStatus,
} from "./model";
export { mlRerank, type MlLayerResult } from "./rerank";
export {
  buildTrainingSet,
  getTrainingLogStore,
  InMemoryTrainingLogStore,
  recordTrainingSample,
  setTrainingLogStore,
  type TrainingItem,
  type TrainingLogStore,
  type TrainingRow,
  type TrainingSample,
  type TrainingSet,
} from "./trainingLog";
