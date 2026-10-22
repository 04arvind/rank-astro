/*
 * First-Out engine: books duration-card consultations (the user picks a
 * length, not an astrologer) by strict round-robin across the provider
 * sheets and their astrologers. The User-Choice ranking in lib/ranking is
 * separate and unaffected.
 */

export { allocateRoundRobin, rotationOrder, type Allocation, type TryPlace } from "./allocator";
export { buildSheets, getFirstOutPool, type Sheet } from "./roster";
export {
  FileRoundRobinStateStore,
  MongoRoundRobinStateStore,
  getRoundRobinStateStore,
  setRoundRobinStateStore,
  type RoundRobinState,
  type RoundRobinStateStore,
  type SheetCursor,
} from "./state";
