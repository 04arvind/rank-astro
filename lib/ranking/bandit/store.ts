import { astrologerArmId, providerArmId } from "./posterior";
import {
  ANY_CONTEXT,
  type ArmIncrement,
  type ArmStats,
  type BanditStore,
  type BanditSummary,
  type ExposureRecord,
  type OutcomeRecord,
  type RecommendationEvent,
} from "./types";

/**
 * Process-local store for development and tests, like the other in-memory
 * defaults. Production installs MongoBanditStore (db/index.ts); without
 * MONGO_URI the learned state does not survive a restart.
 */
export class InMemoryBanditStore implements BanditStore {
  readonly arms = new Map<string, ArmStats>();
  readonly exposures = new Map<string, ExposureRecord>();
  readonly outcomes = new Map<string, OutcomeRecord>();
  readonly recommendations: RecommendationEvent[] = [];
  private readonly meta = new Map<string, unknown>();
  private readonly leases = new Map<string, { owner: string; until: number }>();

  constructor(private readonly maxRecommendations = 10_000) {}

  async getArms(ids: readonly string[]) {
    return ids.map((id) => this.arms.get(id)).filter((a): a is ArmStats => a !== undefined).map((a) => ({ ...a }));
  }

  async incrementArms(updates: readonly ArmIncrement[], now: number) {
    for (const u of updates) {
      const a = this.arms.get(u.id) ?? { ...u, trials: 0, successes: 0, revenue: 0, margin: 0, updatedAt: now };
      this.arms.set(u.id, {
        ...a,
        trials: a.trials + (u.trials ?? 0),
        successes: a.successes + (u.successes ?? 0),
        revenue: a.revenue + (u.revenue ?? 0),
        margin: a.margin + (u.margin ?? 0),
        updatedAt: now,
      });
    }
  }

  async recordExposures(exposures: readonly ExposureRecord[]) {
    const fresh: ExposureRecord[] = [];
    for (const e of exposures) {
      const prev = this.exposures.get(e.id);
      if (prev) {
        this.exposures.set(e.id, { ...prev, lastAt: Math.max(prev.lastAt, e.lastAt), position: Math.min(prev.position, e.position) });
      } else {
        this.exposures.set(e.id, { ...e });
        fresh.push(e);
      }
    }
    return fresh;
  }

  async appendRecommendation(event: RecommendationEvent) {
    this.recommendations.push(event);
    if (this.recommendations.length > this.maxRecommendations) this.recommendations.splice(0, this.recommendations.length - this.maxRecommendations);
  }

  async claimOutcome(o: OutcomeRecord, staleBefore: number) {
    const prev = this.outcomes.get(o.bookingId);
    if (prev && !(prev.status === "pending" && prev.processedAt < staleBefore)) return false;
    this.outcomes.set(o.bookingId, { ...o });
    return true;
  }

  async finishOutcome(bookingId: string, patch: Partial<OutcomeRecord>) {
    const o = this.outcomes.get(bookingId);
    if (!o || o.status !== "pending") return false;
    this.outcomes.set(bookingId, { ...o, ...patch });
    return true;
  }

  async convertExposure(q: { policy: string; viewerKeys: readonly string[]; astrologerId: string; from: number; to: number; bookingId: string }) {
    // A retried booking keeps the exposure it was already credited to.
    for (const e of this.exposures.values()) if (e.policy === q.policy && e.convertedBy === q.bookingId) return { ...e };
    let best: ExposureRecord | undefined;
    for (const e of this.exposures.values()) {
      if (e.policy !== q.policy || e.astrologerId !== q.astrologerId || !q.viewerKeys.includes(e.viewerKey)) continue;
      if ((e.convertedBy !== null && e.convertedBy !== q.bookingId) || e.lastAt < q.from || e.firstAt > q.to) continue;
      if (!best || e.lastAt > best.lastAt) best = e;
    }
    if (!best) return null;
    const done = { ...best, convertedBy: q.bookingId };
    this.exposures.set(best.id, done);
    return done;
  }

  async getMeta<T>(key: string) {
    return (this.meta.get(key) as T | undefined) ?? null;
  }

  async setMeta<T>(key: string, value: T) {
    this.meta.set(key, value);
  }

  async tryLease(name: string, owner: string, until: number, now: number) {
    const l = this.leases.get(name);
    if (l && l.owner !== owner && l.until > now) return false;
    this.leases.set(name, { owner, until });
    return true;
  }

  async releaseLease(name: string, owner: string) {
    if (this.leases.get(name)?.owner === owner) this.leases.delete(name);
  }

  async rebuildArms(policy: string, now: number) {
    for (const [id, a] of this.arms) if (a.policy === policy) this.arms.delete(id);
    const exposures = [...this.exposures.values()].filter((e) => e.policy === policy);
    await this.incrementArms(exposures.flatMap((e) => trialIncrements(e)), now);
    const byExposure = new Map(exposures.map((e) => [e.id, e]));
    const applied = [...this.outcomes.values()].filter((o) => o.policy === policy && o.status === "applied" && o.exposureId);
    await this.incrementArms(
      applied.flatMap((o) => {
        const e = byExposure.get(o.exposureId!);
        return e ? successIncrements(e, o) : [];
      }),
      now,
    );
    return [...this.arms.values()].filter((a) => a.policy === policy).length;
  }

  async summarize(policy: string, since: number): Promise<BanditSummary> {
    const exposures = [...this.exposures.values()].filter((e) => e.policy === policy && e.firstAt >= since);
    const outcomes = [...this.outcomes.values()].filter((o) => o.policy === policy && o.processedAt >= since);
    const applied = outcomes.filter((o) => o.status === "applied");
    const variants = (["treatment", "control"] as const).map((variant) => {
      const ex = exposures.filter((e) => e.variant === variant);
      const out = applied.filter((o) => o.variant === variant);
      return {
        variant,
        exposures: ex.length,
        weightedExposures: ex.reduce((s, e) => s + e.weight, 0),
        completions: out.length,
        revenue: out.reduce((s, o) => s + o.revenue, 0),
        margin: out.reduce((s, o) => s + o.margin, 0),
      };
    });
    const providerIds = new Set([...exposures.map((e) => e.providerId), ...applied.map((o) => o.providerId)]);
    const providers = [...providerIds].map((providerId) => {
      const ex = exposures.filter((e) => e.providerId === providerId);
      const out = applied.filter((o) => o.providerId === providerId);
      return {
        providerId,
        exposures: ex.length,
        weightedExposures: ex.reduce((s, e) => s + e.weight, 0),
        completions: out.length,
        margin: out.reduce((s, o) => s + o.margin, 0),
      };
    });
    const count = (s: OutcomeRecord["status"]) => outcomes.filter((o) => o.status === s).length;
    return { variants, providers, outcomes: { pending: count("pending"), applied: count("applied"), unattributed: count("unattributed") } };
  }

  async topArms(policy: string, limit: number) {
    return [...this.arms.values()]
      .filter((a) => a.policy === policy && a.kind === "astrologer")
      .sort((x, y) => y.trials - x.trials)
      .slice(0, limit)
      .map((a) => ({ ...a }));
  }
}

/** Trial counters one new exposure adds: its context arm, the astrologer's overall arm, the provider arm. */
export function trialIncrements(e: ExposureRecord): ArmIncrement[] {
  return armTargets(e).map((t) => ({ ...t, trials: e.weight }));
}

/** Success counters one attributed outcome adds, on the same arms as its exposure. */
export function successIncrements(e: ExposureRecord, o: Pick<OutcomeRecord, "revenue" | "margin">): ArmIncrement[] {
  return armTargets(e).map((t) => ({ ...t, successes: 1, revenue: o.revenue, margin: o.margin }));
}

function armTargets(e: Pick<ExposureRecord, "policy" | "context" | "astrologerId" | "providerId">): ArmIncrement[] {
  const base = { policy: e.policy, providerId: e.providerId };
  const out: ArmIncrement[] = [
    { ...base, id: providerArmId(e.policy, e.providerId), kind: "provider", context: ANY_CONTEXT },
    { ...base, id: astrologerArmId(e.policy, ANY_CONTEXT, e.astrologerId), kind: "astrologer", context: ANY_CONTEXT, astrologerId: e.astrologerId },
  ];
  if (e.context !== ANY_CONTEXT) {
    out.push({ ...base, id: astrologerArmId(e.policy, e.context, e.astrologerId), kind: "astrologer", context: e.context, astrologerId: e.astrologerId });
  }
  return out;
}

const g = globalThis as unknown as { __banditStore?: BanditStore };

export function getBanditStore(): BanditStore {
  return (g.__banditStore ??= new InMemoryBanditStore());
}

export function setBanditStore(store: BanditStore): void {
  g.__banditStore = store;
}
