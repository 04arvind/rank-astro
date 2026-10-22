import { config } from "@/config";
import { getAstrologerRepository } from "@/lib/astrologer";
import { getBookingStore } from "@/lib/booking";
import { logError } from "@/lib/errors";
import { HOUR_MS, MINUTE_MS } from "@/lib/utils/time";
import type { AstrologerProfile } from "@/types/astrologer";
import type { Booking } from "@/types/booking";
import { resetBanditCache, type BanditContext } from "./policy";
import { marginRateOf } from "./posterior";
import { getBanditStore, successIncrements, trialIncrements } from "./store";
import type { BanditSurface, ExposureRecord, OutcomeRecord, RecommendationEvent } from "./types";

/*
 * Learning loop, all persisted and idempotent:
 *
 *   served list ──▶ recommendation event + exposure ledger ──▶ arm.trials += weight
 *                     (one exposure per viewer × astrologer × context × dedup window)
 *
 *   booking lifecycle ──▶ outcome ledger (_id = bookingId) ──▶ arm.successes += 1
 *     User-Choice booking, call connected and ended (the same "completed"
 *     the astrologer portal shows), credited to the viewer's latest exposure
 *     of that astrologer within attributionHours before the booking.
 *
 * Impressions only ever add trials; only a completed consultation adds a
 * success. First-Out (duration-card) bookings are skipped: the user didn't
 * choose that astrologer from a list. Reconciliation runs on demand from
 * the ranking routes (throttled, under a lease), or from scripts/bandit.ts.
 */

const cfg = () => config.ranking.bandit;

/** Exposure weight for a 1-based position: 1 at the top, decaying with depth. */
export const positionWeight = (position: number) => 1 / (1 + (Math.max(1, position) - 1) / cfg().positionDecay);

export interface ServedItem {
  astrologerId: string;
  providerId: string;
  position: number;
  placement?: string;
}

/**
 * Logs one served User-Choice list: a recommendation event, plus an
 * exposure per astrologer that adds a trial the first time this viewer sees
 * them in the dedup window. Viewers without a user or session id can't be
 * attributed and aren't logged. Call after the response (it never throws).
 */
export async function recordServed(input: {
  bandit: BanditContext | undefined;
  surface: BanditSurface;
  requestId?: string;
  user: { userId?: string; sessionId?: string };
  items: readonly ServedItem[];
  now?: number;
}): Promise<{ exposures: number; newExposures: number }> {
  const { bandit: b, surface, requestId, user, items, now = Date.now() } = input;
  if (!b || !b.viewerKey || items.length === 0) return { exposures: 0, newExposures: 0 };
  const store = getBanditStore();
  const c = cfg();

  try {
    const event: RecommendationEvent = {
      id: requestId ?? crypto.randomUUID(),
      policy: b.policy,
      surface,
      viewerKey: b.viewerKey,
      userId: user.userId,
      sessionId: user.sessionId,
      variant: b.variant,
      mode: b.mode,
      context: b.context,
      at: now,
      items: items.map((it) => {
        const d = b.decisions.get(it.astrologerId);
        return {
          ...it,
          sample: d?.sample ?? null,
          posteriorMean: d?.posterior.mean ?? null,
          reward: d?.reward ?? null,
          layer2Rank: d?.layer2Rank ?? null,
        };
      }),
    };

    // One exposure per astrologer per request, at its best position on the page.
    const best = new Map<string, ServedItem>();
    for (const it of items) {
      const prev = best.get(it.astrologerId);
      if (!prev || it.position < prev.position) best.set(it.astrologerId, it);
    }
    const bucket = Math.floor(now / (c.exposureDedupHours * HOUR_MS));
    const exposures: ExposureRecord[] = [...best.values()].map((it) => {
      const d = b.decisions.get(it.astrologerId);
      return {
        id: `${b.policy}|${b.context}|${b.viewerKey}|${it.astrologerId}|${bucket}`,
        policy: b.policy,
        viewerKey: b.viewerKey!,
        userId: user.userId,
        sessionId: user.sessionId,
        astrologerId: it.astrologerId,
        providerId: it.providerId,
        context: b.context,
        variant: b.variant,
        mode: b.mode,
        surface,
        requestId,
        placement: it.placement,
        position: it.position,
        weight: positionWeight(it.position),
        firstAt: now,
        lastAt: now,
        sample: d?.sample ?? null,
        posteriorMean: d?.posterior.mean ?? null,
        convertedBy: null,
      };
    });

    const [, fresh] = await Promise.all([store.appendRecommendation(event), store.recordExposures(exposures)]);
    if (fresh.length) await store.incrementArms(fresh.flatMap(trialIncrements), now);
    return { exposures: exposures.length, newExposures: fresh.length };
  } catch (err) {
    logError(err, { scope: "bandit", operation: "recordServed", requestId });
    return { exposures: 0, newExposures: 0 };
  }
}

/* ───────────────────────────── outcomes ───────────────────────────── */

/** When the consultation ended; mirrors the astrologer portal's "completed" (lib/astrologer-portal). */
const callEnd = (b: Booking) => (b.kind === "instant" && b.connectedAt ? b.connectedAt + b.durationMinutes * MINUTE_MS : b.endAt);

/** A User-Choice booking whose call connected and has ended: a completed consultation. */
export const isCompletedUserChoice = (b: Booking, now: number) =>
  b.status === "confirmed" && b.minutes === undefined && Boolean(b.connectedAt) && callEnd(b) <= now;

export interface ReconcileResult {
  ran: boolean;
  reason?: string;
  scanned: number;
  completed: number;
  applied: number;
  unattributed: number;
  alreadyProcessed: number;
  failed: number;
  from: number;
  to: number;
}

interface Cursor {
  reconciledTo: number;
  lastRunAt: number;
  last: Omit<ReconcileResult, "ran" | "reason">;
}

const CURSOR_KEY = "reconcile";

/** Credits one completed booking, at most once (the outcome ledger is keyed by bookingId). */
async function processBooking(b: Booking, astrologer: AstrologerProfile | undefined, now: number): Promise<"applied" | "unattributed" | "duplicate"> {
  const store = getBanditStore();
  const c = cfg();
  const revenue = b.pricePerMinute * b.durationMinutes;
  const margin = astrologer ? revenue * marginRateOf(astrologer) : revenue * (config.providers.providers.find((p) => p.id === b.providerId)?.revenueShare ?? 0);
  const outcome: OutcomeRecord = {
    bookingId: b.bookingId,
    policy: c.policyVersion,
    status: "pending",
    astrologerId: b.astrologerId,
    providerId: b.providerId,
    userId: b.userId,
    sessionId: b.sessionId,
    revenue,
    margin,
    bookedAt: b.createdAt,
    completedAt: callEnd(b),
    processedAt: now,
  };
  // A pending claim older than the lease was abandoned mid-way; take it over.
  if (!(await store.claimOutcome(outcome, now - c.reconcile.leaseSeconds * 1000))) return "duplicate";

  const exposure = await store.convertExposure({
    policy: c.policyVersion,
    viewerKeys: [b.userId, ...(b.sessionId ? [b.sessionId] : [])],
    astrologerId: b.astrologerId,
    from: b.createdAt - c.attributionHours * HOUR_MS,
    to: b.createdAt,
    bookingId: b.bookingId,
  });
  if (!exposure) {
    return (await store.finishOutcome(b.bookingId, { status: "unattributed", processedAt: now })) ? "unattributed" : "duplicate";
  }
  // pending → applied is the compare-and-set that makes the success count once;
  // counters follow it (a crash in between is repaired by rebuildArms from the ledger).
  const won = await store.finishOutcome(b.bookingId, {
    status: "applied",
    exposureId: exposure.id,
    context: exposure.context,
    variant: exposure.variant,
    requestId: exposure.requestId,
    processedAt: now,
  });
  if (!won) return "duplicate";
  await store.incrementArms(successIncrements(exposure, outcome), now);
  return "applied";
}

/**
 * Turns completed User-Choice bookings since the last run into successes.
 * Re-scans lookbackHours behind the cursor (late connections, retries) —
 * safe because each booking is claimed once. One process at a time (lease).
 */
export async function reconcileOutcomes({ now = Date.now(), owner = `${process.pid}:${Math.random().toString(36).slice(2)}` } = {}): Promise<ReconcileResult> {
  const c = cfg();
  const store = getBanditStore();
  const empty = { scanned: 0, completed: 0, applied: 0, unattributed: 0, alreadyProcessed: 0, failed: 0, from: now, to: now };
  if (!(await store.tryLease(CURSOR_KEY, owner, now + c.reconcile.leaseSeconds * 1000, now))) {
    return { ran: false, reason: "another process is reconciling", ...empty };
  }
  try {
    const prev = await store.getMeta<Cursor>(CURSOR_KEY);
    const lookback = c.reconcile.lookbackHours * HOUR_MS;
    const from = (prev?.reconciledTo ?? now - c.attributionHours * HOUR_MS) - lookback;
    // Overlap query: anything whose [startAt, endAt) touches [from, now) — includes every call that ended in it.
    const bookings = await getBookingStore().list({ from, to: now, statuses: ["confirmed"] });
    const done = bookings.filter((b) => isCompletedUserChoice(b, now) && callEnd(b) >= from);
    const astrologers = new Map(
      (done.length ? await getAstrologerRepository().getByIds([...new Set(done.map((b) => b.astrologerId))]) : []).map((a) => [a.id, a]),
    );

    const result = { ...empty, from, scanned: bookings.length, completed: done.length };
    for (const b of done) {
      try {
        const r = await processBooking(b, astrologers.get(b.astrologerId), now);
        if (r === "applied") result.applied++;
        else if (r === "unattributed") result.unattributed++;
        else result.alreadyProcessed++;
      } catch (err) {
        result.failed++;
        logError(err, { scope: "bandit", operation: "processBooking", bookingId: b.bookingId });
      }
    }
    // A failed booking stays behind the cursor's lookback, so the next run retries it.
    await store.setMeta<Cursor>(CURSOR_KEY, { reconciledTo: result.failed ? Math.min(now, from + lookback) : now, lastRunAt: now, last: result });
    if (result.applied) resetBanditCache();
    return { ran: true, ...result };
  } finally {
    await store.releaseLease(CURSOR_KEY, owner).catch(() => {});
  }
}

const g = globalThis as unknown as { __banditReconcileAt?: number };

/** On-demand trigger from request handlers: at most once per reconcile.intervalSeconds per process; never throws. */
export async function maybeReconcile(now = Date.now()): Promise<void> {
  const c = cfg();
  if (g.__banditReconcileAt !== undefined && now - g.__banditReconcileAt < c.reconcile.intervalSeconds * 1000) return;
  g.__banditReconcileAt = now;
  try {
    await reconcileOutcomes({ now });
  } catch (err) {
    logError(err, { scope: "bandit", operation: "reconcile" });
  }
}

export const reconcileCursor = () => getBanditStore().getMeta<Cursor>(CURSOR_KEY);

/** Recomputes the policy's arms from the ledgers (repair after a partial failure, or audit). */
export async function rebuildArms(policy = cfg().policyVersion, now = Date.now()): Promise<number> {
  const n = await getBanditStore().rebuildArms(policy, now);
  resetBanditCache();
  return n;
}
