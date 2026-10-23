import { getAstrologerRepository } from "@/lib/astrologer";
import { logError } from "@/lib/errors";
import type { AstrologerProfile } from "@/types/astrologer";
import { buildSheets, type Sheet } from "./roster";
import { emptyState, getRoundRobinStateStore, type RoundRobinState, type SheetCursor } from "./state";

/*
 * Weighted round-robin allocation for First-Out bookings (the user picks a
 * duration, never an astrologer), so every astrologer gets a fair share of
 * calls whichever provider they are with:
 *
 *   Across sheets — smooth weighted round-robin. Each sheet's weight is how
 *   many of its astrologers are free for this call (in the pool). Every
 *   allocation adds each sheet's weight to its credit; the sheet with the
 *   highest credit takes the turn and pays back the total weight. Turns are
 *   interleaved and proportional to free astrologers: a sheet with 50 free
 *   gets ~10× the calls of a sheet with 5, i.e. the same per astrologer.
 *   Ties go to the sheet whose plain round-robin turn is next.
 *
 *   Within a sheet — longest idle first: the astrologer whose last
 *   First-Out allocation is oldest (never allocated = first). Ties keep the
 *   sheet's row rotation, so a fresh roster is served row by row.
 *
 * Positions index the full sheet (every astrologer in the feed), so they
 * don't shift when someone goes offline. An astrologer who can't take this
 * call (not in the pool, or the booking store says busy) is skipped for the
 * next one in the same sheet; a sheet with nobody free passes its turn to
 * the sheet with the next-highest credit.
 *
 * Allocations are atomic: one at a time in this process, and under the
 * state store's lock across processes, so concurrent payments can't read
 * the same cursor. The cursor is persisted before the lock is released.
 */

export interface Allocation<T> {
  astrologer: AstrologerProfile;
  result: T;
  /** Where the turn landed, for logs and debugging. */
  providerId: string;
  position: number;
}

/**
 * Tries to book `a`; returns null if `a` is busy (moves on to the next
 * candidate). Any thrown error aborts the allocation without advancing it.
 */
export type TryPlace<T> = (a: AstrologerProfile) => Promise<T | null>;

const g = globalThis as unknown as { __firstOutQueue?: Promise<unknown> };

/** Runs `fn` after every earlier allocation in this process has finished. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__firstOutQueue ?? Promise.resolve()).then(fn, fn);
  g.__firstOutQueue = run.catch(() => {});
  return run;
}

/** Where the sheet's next turn starts: after its last astrologer, wherever that row is now. */
function startOf(sheet: Sheet, cursor: SheetCursor | undefined): number {
  const len = sheet.astrologers.length;
  if (!cursor) return 0;
  const { next, lastAstrologerId } = cursor;
  if (lastAstrologerId && sheet.astrologers[(next - 1 + len) % len]?.id !== lastAstrologerId) {
    const i = sheet.astrologers.findIndex((a) => a.id === lastAstrologerId);
    if (i >= 0) return (i + 1) % len;
  }
  return ((next % len) + len) % len;
}

async function loadState(): Promise<RoundRobinState> {
  try {
    return await getRoundRobinStateStore().load();
  } catch (err) {
    // A lost cursor only restarts the rotation; it must not block a paid booking.
    logError(err, { scope: "first-out", operation: "loadState" });
    return emptyState();
  }
}

/** Each sheet's credit after this allocation's weights are added (weight = its free astrologers), and the total weight. */
function creditsAfterAdd(sheets: Sheet[], state: RoundRobinState, pool: ReadonlySet<string>): { credits: Record<string, number>; total: number } {
  const credits: Record<string, number> = {};
  let total = 0;
  for (const sheet of sheets) {
    const weight = sheet.astrologers.filter((a) => pool.has(a.id)).length;
    // A sheet with nobody free keeps its credit as it was; it isn't owed turns it couldn't take.
    credits[sheet.providerId] = (state.credits?.[sheet.providerId] ?? 0) + weight;
    total += weight;
  }
  // Bound drift from roster/pool changes: no sheet is ever more than one full round ahead or behind.
  for (const id of Object.keys(credits)) credits[id] = Math.max(-total, Math.min(total, credits[id]));
  return { credits, total };
}

/** The order the next allocation would try `pool`'s astrologers in (no booking, no state change). */
export function rotationOrder(sheets: Sheet[], state: RoundRobinState, pool: ReadonlySet<string>): { astrologer: AstrologerProfile; sheet: number; position: number }[] {
  const n = sheets.length;
  const { credits } = creditsAfterAdd(sheets, state, pool);
  // Highest credit first; ties by plain round-robin distance from nextSheet.
  const turn = (s: number) => (((s - state.nextSheet) % n) + n) % n;
  const sheetOrder = sheets
    .map((_, s) => s)
    .sort((x, y) => credits[sheets[y].providerId] - credits[sheets[x].providerId] || turn(x) - turn(y));

  const order: { astrologer: AstrologerProfile; sheet: number; position: number }[] = [];
  for (const s of sheetOrder) {
    const sheet = sheets[s];
    const len = sheet.astrologers.length;
    if (len === 0) continue;
    const start = startOf(sheet, state.sheets[sheet.providerId]);
    const free: { astrologer: AstrologerProfile; sheet: number; position: number; rotation: number }[] = [];
    for (let j = 0; j < len; j++) {
      const position = (start + j) % len;
      const astrologer = sheet.astrologers[position];
      if (pool.has(astrologer.id)) free.push({ astrologer, sheet: s, position, rotation: j });
    }
    // Longest idle first (never allocated = 0); ties keep the row rotation.
    const servedAt = (a: AstrologerProfile) => state.lastServedAt?.[a.id] ?? 0;
    free.sort((x, y) => servedAt(x.astrologer) - servedAt(y.astrologer) || x.rotation - y.rotation);
    for (const { astrologer, position } of free) order.push({ astrologer, sheet: s, position });
  }
  return order;
}

/**
 * Books the next astrologer in the rotation that `tryPlace` accepts and
 * advances the rotation past them. `pool` is who may take this call;
 * returns null if nobody in it could.
 */
export function allocateRoundRobin<T>(pool: readonly AstrologerProfile[], tryPlace: TryPlace<T>, now = Date.now()): Promise<Allocation<T> | null> {
  return serialized(async () => {
    if (pool.length === 0) return null;
    const sheets = buildSheets(await getAstrologerRepository().list());
    const release = await getRoundRobinStateStore().lock();
    try {
      return await allocateLocked(sheets, pool, tryPlace, now);
    } finally {
      await release();
    }
  });
}

async function allocateLocked<T>(sheets: Sheet[], pool: readonly AstrologerProfile[], tryPlace: TryPlace<T>, now: number): Promise<Allocation<T> | null> {
  const state = await loadState();
  const free = new Set(pool.map((a) => a.id));

  for (const { astrologer, sheet, position } of rotationOrder(sheets, state, free)) {
    const result = await tryPlace(astrologer);
    if (result === null) continue;

    const { providerId, astrologers } = sheets[sheet];
    const { credits, total } = creditsAfterAdd(sheets, state, free);
    credits[providerId] -= total; // the sheet that took the turn pays back the round's total weight
    // Keep idle times only for astrologers still on a sheet, so the state doesn't grow with roster churn.
    const onRoster = new Set(sheets.flatMap((s) => s.astrologers.map((a) => a.id)));
    const lastServedAt = Object.fromEntries(Object.entries(state.lastServedAt ?? {}).filter(([id]) => onRoster.has(id)));
    lastServedAt[astrologer.id] = now;
    const next: RoundRobinState = {
      nextSheet: (sheet + 1) % sheets.length,
      sheets: { ...state.sheets, [providerId]: { next: (position + 1) % astrologers.length, lastAstrologerId: astrologer.id } },
      credits,
      lastServedAt,
      allocations: state.allocations + 1,
      updatedAt: now,
    };
    try {
      await getRoundRobinStateStore().save(next);
    } catch (err) {
      // The booking is made; a failed save only means the next user may get this turn again.
      logError(err, { scope: "first-out", operation: "saveState", astrologerId: astrologer.id });
    }
    return { astrologer, result, providerId, position };
  }
  return null;
}
