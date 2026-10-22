import { getAstrologerRepository } from "@/lib/astrologer";
import { logError } from "@/lib/errors";
import type { AstrologerProfile } from "@/types/astrologer";
import { buildSheets, type Sheet } from "./roster";
import { emptyState, getRoundRobinStateStore, type RoundRobinState, type SheetCursor } from "./state";

/*
 * Strict round-robin allocation for First-Out bookings (the user picks a
 * duration, never an astrologer). Turns rotate across the sheets, and
 * within a sheet down its rows:
 *
 *   user 1 → A[0], user 2 → B[0], user 3 → C[0], user 4 → A[1], …
 *
 * Positions index the full sheet (every astrologer in the feed), so they
 * don't shift when someone goes offline. An astrologer who can't take this
 * call (not in the pool, or the booking store says busy) is skipped for the
 * next row of the same sheet; a sheet with nobody free passes its turn to
 * the next sheet. A short sheet wraps to its first row on its own.
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

/** The order the next allocation would try `pool`'s astrologers in (no booking, no state change). */
export function rotationOrder(sheets: Sheet[], state: RoundRobinState, pool: ReadonlySet<string>): { astrologer: AstrologerProfile; sheet: number; position: number }[] {
  const order: { astrologer: AstrologerProfile; sheet: number; position: number }[] = [];
  const n = sheets.length;
  for (let k = 0; k < n; k++) {
    const s = (((state.nextSheet + k) % n) + n) % n;
    const sheet = sheets[s];
    const len = sheet.astrologers.length;
    if (len === 0) continue;
    const start = startOf(sheet, state.sheets[sheet.providerId]);
    for (let j = 0; j < len; j++) {
      const position = (start + j) % len;
      const astrologer = sheet.astrologers[position];
      if (pool.has(astrologer.id)) order.push({ astrologer, sheet: s, position });
    }
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

  for (const { astrologer, sheet, position } of rotationOrder(sheets, state, new Set(pool.map((a) => a.id)))) {
    const result = await tryPlace(astrologer);
    if (result === null) continue;

    const { providerId, astrologers } = sheets[sheet];
    const next: RoundRobinState = {
      nextSheet: (sheet + 1) % sheets.length,
      sheets: { ...state.sheets, [providerId]: { next: (position + 1) % astrologers.length, lastAstrologerId: astrologer.id } },
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
