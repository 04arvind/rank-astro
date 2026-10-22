import { MongoServerError, type Db } from "mongodb";
import { config } from "@/config";
import { DatabaseError } from "@/lib/errors";
import type { TrainingLogStore, TrainingSample } from "@/lib/ranking/ml/trainingLog";
import { DAY_MS } from "@/lib/utils/time";
import { getDb } from "./client";

/*
 * Learned-ranker training log in MongoDB:
 *
 *   ranking_training_samples   _id = requestId; one served list with each
 *                              item's feature row (TTL ml.trainingLog.retentionDays)
 *
 * A new collection — no existing collection or document shape changes.
 */

const DUPLICATE_KEY = 11000;
const COLLECTION = "ranking_training_samples";

type SampleDoc = Omit<TrainingSample, "id"> & { _id: string; expiresAt: Date };

export class MongoTrainingLogStore implements TrainingLogStore {
  private indexed?: Promise<unknown>;

  constructor(private readonly db: () => Promise<Db> = getDb) {}

  private async col() {
    const c = (await this.db()).collection<SampleDoc>(COLLECTION);
    this.indexed ??= c.createIndexes([{ key: { at: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }]).catch((err) => {
      this.indexed = undefined;
      throw err;
    });
    await this.indexed;
    return c;
  }

  async append(sample: TrainingSample) {
    try {
      const { id, ...rest } = sample;
      await (await this.col()).insertOne({ ...rest, _id: id, expiresAt: new Date(sample.at + config.ranking.ml.trainingLog.retentionDays * DAY_MS) });
    } catch (err) {
      if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) return; // retried request
      throw new DatabaseError("Training log append failed", { operation: "append", collection: COLLECTION }, { cause: err });
    }
  }

  async list({ from, to, limit }: { from: number; to: number; limit?: number }) {
    try {
      const cursor = (await this.col()).find({ at: { $gte: from, $lt: to } }, { projection: { expiresAt: 0 } }).sort({ at: 1 });
      if (limit) cursor.limit(limit);
      return (await cursor.toArray()).map(({ _id, ...s }) => ({ ...s, id: _id }) as TrainingSample);
    } catch (err) {
      throw new DatabaseError("Training log list failed", { operation: "list", collection: COLLECTION }, { cause: err });
    }
  }
}
