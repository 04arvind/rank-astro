import { MongoBulkWriteError, MongoServerError, type AnyBulkWriteOperation, type Db } from "mongodb";
import { config } from "@/config";
import { DatabaseError } from "@/lib/errors";
import { successIncrements, trialIncrements } from "@/lib/ranking/bandit/store";
import type {
  ArmIncrement,
  ArmStats,
  BanditStore,
  BanditSummary,
  ExposureRecord,
  OutcomeRecord,
  RecommendationEvent,
} from "@/lib/ranking/bandit/types";
import { DAY_MS } from "@/lib/utils/time";
import { getDb } from "./client";

/*
 * Bandit state in MongoDB:
 *
 *   bandit_arms             _id = arm id; Beta counters, updated with $inc
 *   bandit_exposures        _id = policy|context|viewer|astrologer|bucket — the
 *                           unique _id is what makes a trial count once (TTL)
 *   bandit_outcomes         _id = bookingId — a success counts once
 *   recommendation_events   _id = requestId; what was served and sampled (TTL)
 *   bandit_meta             cursor, runtime flags, leases
 *
 * Counters are a cache of the two ledgers; rebuildArms() recomputes them.
 */

const DUPLICATE_KEY = 11000;
const C = {
  arms: "bandit_arms",
  exposures: "bandit_exposures",
  outcomes: "bandit_outcomes",
  events: "recommendation_events",
  meta: "bandit_meta",
} as const;

type ArmDoc = Omit<ArmStats, "id"> & { _id: string };
type ExposureDoc = Omit<ExposureRecord, "id"> & { _id: string; expiresAt: Date };
type OutcomeDoc = Omit<OutcomeRecord, "bookingId"> & { _id: string };
type EventDoc = Omit<RecommendationEvent, "id"> & { _id: string; expiresAt: Date };
interface MetaDoc {
  _id: string;
  value?: unknown;
  owner?: string;
  until?: number;
}

const fromArm = ({ _id, ...a }: ArmDoc): ArmStats => ({ id: _id, ...a });
const fromExposure = ({ _id, expiresAt, ...e }: ExposureDoc): ExposureRecord => {
  void expiresAt;
  return { id: _id, ...e };
};

const expiry = (t: number) => new Date(t + config.ranking.bandit.retentionDays * DAY_MS);

export class MongoBanditStore implements BanditStore {
  private indexed?: Promise<unknown>;

  constructor(private readonly db: () => Promise<Db> = getDb) {}

  private async cols() {
    const db = await this.db();
    const cols = {
      arms: db.collection<ArmDoc>(C.arms),
      exposures: db.collection<ExposureDoc>(C.exposures),
      outcomes: db.collection<OutcomeDoc>(C.outcomes),
      events: db.collection<EventDoc>(C.events),
      meta: db.collection<MetaDoc>(C.meta),
    };
    this.indexed ??= Promise.all([
      cols.arms.createIndex({ policy: 1, kind: 1, trials: -1 }),
      cols.exposures.createIndexes([
        { key: { policy: 1, astrologerId: 1, viewerKey: 1, lastAt: -1 } },
        { key: { policy: 1, firstAt: 1 } },
        { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      ]),
      cols.outcomes.createIndexes([{ key: { policy: 1, processedAt: 1 } }, { key: { policy: 1, status: 1 } }]),
      cols.events.createIndexes([{ key: { at: -1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }]),
      // Reconciliation scans confirmed bookings by end time (lib/booking list overlap query).
      db.collection("bookings").createIndex({ status: 1, endAt: 1 }),
    ]).catch((err) => {
      this.indexed = undefined;
      throw err;
    });
    await this.indexed;
    return cols;
  }

  private async run<T>(operation: string, fn: (c: Awaited<ReturnType<MongoBanditStore["cols"]>>) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.cols());
    } catch (err) {
      throw new DatabaseError(`Bandit store ${operation} failed`, { operation, collection: "bandit_*" }, { cause: err });
    }
  }

  getArms(ids: readonly string[]) {
    return this.run("getArms", async (c) => (await c.arms.find({ _id: { $in: [...ids] } }).toArray()).map(fromArm));
  }

  incrementArms(updates: readonly ArmIncrement[], now: number) {
    return this.run("incrementArms", async (c) => {
      if (updates.length === 0) return;
      const ops: AnyBulkWriteOperation<ArmDoc>[] = updates.map(({ id, trials = 0, successes = 0, revenue = 0, margin = 0, ...key }) => ({
        updateOne: {
          filter: { _id: id },
          update: {
            $inc: { trials, successes, revenue, margin },
            $set: { updatedAt: now },
            $setOnInsert: { policy: key.policy, kind: key.kind, context: key.context, providerId: key.providerId, ...(key.astrologerId ? { astrologerId: key.astrologerId } : {}) },
          },
          upsert: true,
        },
      }));
      await c.arms.bulkWrite(ops, { ordered: false });
    });
  }

  recordExposures(exposures: readonly ExposureRecord[]) {
    return this.run("recordExposures", async (c) => {
      if (exposures.length === 0) return [];
      // Upsert on the unique _id: only the request that inserts an exposure gets to count its trial.
      const ops: AnyBulkWriteOperation<ExposureDoc>[] = exposures.map(({ id, lastAt, position, ...e }) => ({
        updateOne: {
          filter: { _id: id },
          update: { $setOnInsert: { ...e, expiresAt: expiry(e.firstAt) }, $max: { lastAt }, $min: { position } },
          upsert: true,
        },
      }));
      let inserted: Record<number, unknown>;
      try {
        inserted = (await c.exposures.bulkWrite(ops, { ordered: false })).upsertedIds;
      } catch (err) {
        // Two requests upserting the same new _id: the loser's write fails with a duplicate key — it didn't insert.
        if (!(err instanceof MongoBulkWriteError) || err.writeErrors === undefined) throw err;
        const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
        if (!errors.every((w) => w.code === DUPLICATE_KEY)) throw err;
        inserted = err.result.upsertedIds;
      }
      return Object.keys(inserted).map((i) => exposures[Number(i)]);
    });
  }

  appendRecommendation(event: RecommendationEvent) {
    return this.run("appendRecommendation", async (c) => {
      const { id, ...rest } = event;
      try {
        await c.events.insertOne({ ...rest, _id: id, expiresAt: expiry(event.at) });
      } catch (err) {
        if (!(err instanceof MongoServerError && err.code === DUPLICATE_KEY)) throw err; // retried request
      }
    });
  }

  claimOutcome(o: OutcomeRecord, staleBefore: number) {
    return this.run("claimOutcome", async (c) => {
      const { bookingId, ...rest } = o;
      try {
        await c.outcomes.insertOne({ ...rest, _id: bookingId });
        return true;
      } catch (err) {
        if (!(err instanceof MongoServerError && err.code === DUPLICATE_KEY)) throw err;
      }
      const took = await c.outcomes.findOneAndUpdate(
        { _id: bookingId, status: "pending", processedAt: { $lt: staleBefore } },
        { $set: { processedAt: o.processedAt } },
      );
      return took !== null;
    });
  }

  finishOutcome(bookingId: string, patch: Partial<OutcomeRecord>) {
    return this.run("finishOutcome", async (c) => {
      const { bookingId: _b, ...set } = patch;
      void _b;
      const res = await c.outcomes.updateOne({ _id: bookingId, status: "pending" }, { $set: set });
      return res.modifiedCount === 1;
    });
  }

  convertExposure(q: { policy: string; viewerKeys: readonly string[]; astrologerId: string; from: number; to: number; bookingId: string }) {
    return this.run("convertExposure", async (c) => {
      const already = await c.exposures.findOne({ policy: q.policy, astrologerId: q.astrologerId, convertedBy: q.bookingId });
      if (already) return fromExposure(already);
      const doc = await c.exposures.findOneAndUpdate(
        {
          policy: q.policy,
          astrologerId: q.astrologerId,
          viewerKey: { $in: [...q.viewerKeys] },
          convertedBy: null,
          firstAt: { $lte: q.to },
          lastAt: { $gte: q.from },
        },
        { $set: { convertedBy: q.bookingId } },
        { sort: { lastAt: -1 }, returnDocument: "after" },
      );
      return doc ? fromExposure(doc) : null;
    });
  }

  getMeta<T>(key: string) {
    return this.run("getMeta", async (c) => ((await c.meta.findOne({ _id: `meta:${key}` }))?.value as T | undefined) ?? null);
  }

  setMeta<T>(key: string, value: T) {
    return this.run("setMeta", async (c) => {
      await c.meta.updateOne({ _id: `meta:${key}` }, { $set: { value } }, { upsert: true });
    });
  }

  tryLease(name: string, owner: string, until: number, now: number) {
    return this.run("tryLease", async (c) => {
      try {
        // Matches a free, expired or own lease; otherwise the upsert collides with the held one.
        await c.meta.updateOne(
          { _id: `lease:${name}`, $or: [{ until: { $lte: now } }, { owner }, { until: { $exists: false } }] },
          { $set: { owner, until } },
          { upsert: true },
        );
        return true;
      } catch (err) {
        if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) return false;
        throw err;
      }
    });
  }

  releaseLease(name: string, owner: string) {
    return this.run("releaseLease", async (c) => {
      await c.meta.deleteOne({ _id: `lease:${name}`, owner });
    });
  }

  rebuildArms(policy: string, now: number) {
    return this.run("rebuildArms", async (c) => {
      const totals = new Map<string, ArmIncrement & { trials: number; successes: number; revenue: number; margin: number }>();
      const add = (incs: ArmIncrement[]) => {
        for (const u of incs) {
          const t = totals.get(u.id) ?? { ...u, trials: 0, successes: 0, revenue: 0, margin: 0 };
          t.trials += u.trials ?? 0;
          t.successes += u.successes ?? 0;
          t.revenue += u.revenue ?? 0;
          t.margin += u.margin ?? 0;
          totals.set(u.id, t);
        }
      };
      const byExposure = new Map<string, ExposureRecord>();
      for await (const doc of c.exposures.find({ policy })) {
        const e = fromExposure(doc);
        byExposure.set(e.id, e);
        add(trialIncrements(e));
      }
      for await (const o of c.outcomes.find({ policy, status: "applied" })) {
        const e = o.exposureId ? byExposure.get(o.exposureId) : undefined;
        if (e) add(successIncrements(e, o));
      }
      await c.arms.deleteMany({ policy });
      const docs: ArmDoc[] = [...totals.values()].map(({ id, ...a }) => ({ _id: id, ...a, updatedAt: now }));
      for (let i = 0; i < docs.length; i += 1000) await c.arms.insertMany(docs.slice(i, i + 1000), { ordered: false });
      return docs.length;
    });
  }

  summarize(policy: string, since: number) {
    return this.run("summarize", async (c): Promise<BanditSummary> => {
      const [byVariant, byProvider, outcomeVariants, outcomeProviders, statuses] = await Promise.all([
        c.exposures.aggregate<{ _id: string; n: number; w: number }>([
          { $match: { policy, firstAt: { $gte: since } } },
          { $group: { _id: "$variant", n: { $sum: 1 }, w: { $sum: "$weight" } } },
        ]).toArray(),
        c.exposures.aggregate<{ _id: string; n: number; w: number }>([
          { $match: { policy, firstAt: { $gte: since } } },
          { $group: { _id: "$providerId", n: { $sum: 1 }, w: { $sum: "$weight" } } },
        ]).toArray(),
        c.outcomes.aggregate<{ _id: string; n: number; revenue: number; margin: number }>([
          { $match: { policy, status: "applied", processedAt: { $gte: since } } },
          { $group: { _id: "$variant", n: { $sum: 1 }, revenue: { $sum: "$revenue" }, margin: { $sum: "$margin" } } },
        ]).toArray(),
        c.outcomes.aggregate<{ _id: string; n: number; margin: number }>([
          { $match: { policy, status: "applied", processedAt: { $gte: since } } },
          { $group: { _id: "$providerId", n: { $sum: 1 }, margin: { $sum: "$margin" } } },
        ]).toArray(),
        c.outcomes.aggregate<{ _id: OutcomeRecord["status"]; n: number }>([
          { $match: { policy, processedAt: { $gte: since } } },
          { $group: { _id: "$status", n: { $sum: 1 } } },
        ]).toArray(),
      ]);
      const variants = (["treatment", "control"] as const).map((variant) => {
        const e = byVariant.find((x) => x._id === variant);
        const o = outcomeVariants.find((x) => x._id === variant);
        return { variant, exposures: e?.n ?? 0, weightedExposures: e?.w ?? 0, completions: o?.n ?? 0, revenue: o?.revenue ?? 0, margin: o?.margin ?? 0 };
      });
      const ids = new Set([...byProvider.map((p) => p._id), ...outcomeProviders.map((p) => p._id)]);
      const providers = [...ids].map((providerId) => {
        const e = byProvider.find((x) => x._id === providerId);
        const o = outcomeProviders.find((x) => x._id === providerId);
        return { providerId, exposures: e?.n ?? 0, weightedExposures: e?.w ?? 0, completions: o?.n ?? 0, margin: o?.margin ?? 0 };
      });
      const count = (s: OutcomeRecord["status"]) => statuses.find((x) => x._id === s)?.n ?? 0;
      return { variants, providers, outcomes: { pending: count("pending"), applied: count("applied"), unattributed: count("unattributed") } };
    });
  }

  topArms(policy: string, limit: number) {
    return this.run("topArms", async (c) => (await c.arms.find({ policy, kind: "astrologer" }).sort({ trials: -1 }).limit(limit).toArray()).map(fromArm));
  }
}

