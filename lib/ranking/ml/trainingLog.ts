import { config } from "@/config";
import { getAnalyticsStore } from "@/lib/analytics";
import { getBookingStore } from "@/lib/booking";
import { logError } from "@/lib/errors";
import { DAY_MS, HOUR_MS } from "@/lib/utils/time";
import type { Booking } from "@/types/booking";
import { isCompletedUserChoice } from "../bandit/learning";
import { ML_FEATURE_NAMES, ML_FEATURE_VERSION, type FeatureRow } from "./features";

/*
 * Training data for Layer 4. Every served User-Choice list is logged with
 * each item's feature row as it was at serving time (no leakage from later
 * data). Labels are joined at export time from what happened next:
 *
 *   3  completed consultation (call connected and ended)
 *   2  booked
 *   1  clicked in that list (analytics click with the same requestId)
 *   0  shown only
 *
 * A booking is credited to the viewer's latest list that showed that
 * astrologer within bandit.attributionHours before it, so one booking
 * labels one list. First-Out (duration-card) bookings are skipped.
 */

export interface TrainingItem {
  astrologerId: string;
  providerId: string;
  position: number;
  placement?: string;
  features: FeatureRow;
}

export interface TrainingSample {
  /** The API requestId. */
  id: string;
  at: number;
  surface: "rank" | "feed";
  featureVersion: string;
  userId?: string;
  sessionId?: string;
  category?: string;
  segment?: string;
  items: TrainingItem[];
}

export interface TrainingLogStore {
  append(sample: TrainingSample): Promise<void>;
  /** Samples with at in [from, to), oldest first. */
  list(q: { from: number; to: number; limit?: number }): Promise<TrainingSample[]>;
}

export class InMemoryTrainingLogStore implements TrainingLogStore {
  readonly samples: TrainingSample[] = [];
  constructor(private readonly max = 5_000) {}

  async append(sample: TrainingSample) {
    if (this.samples.some((s) => s.id === sample.id)) return;
    this.samples.push(sample);
    if (this.samples.length > this.max) this.samples.splice(0, this.samples.length - this.max);
  }

  async list({ from, to, limit }: { from: number; to: number; limit?: number }) {
    const out = this.samples.filter((s) => s.at >= from && s.at < to).sort((a, b) => a.at - b.at);
    return limit ? out.slice(0, limit) : out;
  }
}

const g = globalThis as unknown as { __trainingLog?: TrainingLogStore };

export const getTrainingLogStore = (): TrainingLogStore => (g.__trainingLog ??= new InMemoryTrainingLogStore());
export function setTrainingLogStore(store: TrainingLogStore): void {
  g.__trainingLog = store;
}

/** Logs one served list. Call after the response; never throws. */
export async function recordTrainingSample(input: {
  requestId: string;
  surface: TrainingSample["surface"];
  user: { userId?: string; sessionId?: string };
  category?: string;
  segment?: string;
  items: readonly { astrologerId: string; providerId: string; position: number; placement?: string }[];
  rows: ReadonlyMap<string, FeatureRow>;
  now?: number;
}): Promise<boolean> {
  const cfg = config.ranking.ml.trainingLog;
  if (!cfg.enabled || (!input.user.userId && !input.user.sessionId)) return false;
  try {
    const items = input.items
      .filter((it) => input.rows.has(it.astrologerId))
      .slice(0, cfg.maxItemsPerRequest)
      .map((it) => ({ ...it, features: input.rows.get(it.astrologerId)! }));
    if (items.length < 2) return false; // a single item teaches a ranker nothing
    await getTrainingLogStore().append({
      id: input.requestId,
      at: input.now ?? Date.now(),
      surface: input.surface,
      featureVersion: ML_FEATURE_VERSION,
      userId: input.user.userId,
      sessionId: input.user.sessionId,
      category: input.category,
      segment: input.segment,
      items,
    });
    return true;
  } catch (err) {
    logError(err, { scope: "ranking", operation: "recordTrainingSample", requestId: input.requestId });
    return false;
  }
}

export interface TrainingRow {
  qid: string;
  at: number;
  astrologerId: string;
  position: number;
  label: 0 | 1 | 2 | 3;
  features: FeatureRow;
}

export interface TrainingSet {
  featureNames: readonly string[];
  featureVersion: string;
  rows: TrainingRow[];
  queries: number;
  positiveQueries: number;
  skipped: { otherFeatureVersion: number; tooSmall: number };
  from: number;
  to: number;
}

const bookingLabel = (b: Booking, now: number): 2 | 3 => (isCompletedUserChoice(b, now) ? 3 : 2);

/** Joins logged lists with clicks and bookings into graded relevance labels. */
export async function buildTrainingSet({ from, to = Date.now(), now = to }: { from: number; to?: number; now?: number }): Promise<TrainingSet> {
  const samples = await getTrainingLogStore().list({ from, to });
  const skipped = { otherFeatureVersion: 0, tooSmall: 0 };
  const usable = samples.filter((s) => {
    if (s.featureVersion !== ML_FEATURE_VERSION) return void skipped.otherFeatureVersion++, false;
    if (s.items.length < 2) return void skipped.tooSmall++, false;
    return true;
  });

  const attribution = config.ranking.bandit.attributionHours * HOUR_MS;
  const [clicks, bookings] = await Promise.all([
    getAnalyticsStore().query({ type: "click", range: { from, to: to + attribution } }),
    // Overlap query on call time: scheduled calls can be days after the booking.
    getBookingStore().list({ from, to: to + 30 * DAY_MS, statuses: ["confirmed", "cancelled"] }),
  ]);

  const labels = new Map<string, number>(); // `${sampleId}|${astrologerId}` → label
  const bump = (key: string, label: number) => labels.set(key, Math.max(labels.get(key) ?? 0, label));

  const byRequest = new Map(usable.map((s) => [s.id, s]));
  for (const c of clicks) {
    const s = c.requestId ? byRequest.get(c.requestId) : undefined;
    if (s?.items.some((it) => it.astrologerId === c.astrologerId)) bump(`${s.id}|${c.astrologerId}`, 1);
  }

  // Latest list per viewer that showed the astrologer, before the booking and within the attribution window.
  const byViewer = new Map<string, TrainingSample[]>();
  for (const s of usable) for (const k of [s.userId, s.sessionId]) if (k) byViewer.set(k, [...(byViewer.get(k) ?? []), s]);
  for (const b of bookings) {
    if (b.minutes !== undefined || b.createdAt < from || b.createdAt >= to + attribution) continue; // First-Out or outside range
    const candidates = [...(byViewer.get(b.userId) ?? []), ...(b.sessionId ? (byViewer.get(b.sessionId) ?? []) : [])].filter(
      (s) => s.at <= b.createdAt && b.createdAt - s.at <= attribution && s.items.some((it) => it.astrologerId === b.astrologerId),
    );
    const latest = candidates.sort((x, y) => y.at - x.at)[0];
    if (latest) bump(`${latest.id}|${b.astrologerId}`, b.status === "confirmed" ? bookingLabel(b, now) : 1);
  }

  const rows: TrainingRow[] = [];
  let positiveQueries = 0;
  for (const s of usable) {
    let positive = false;
    for (const it of s.items) {
      const label = (labels.get(`${s.id}|${it.astrologerId}`) ?? 0) as TrainingRow["label"];
      if (label > 0) positive = true;
      rows.push({ qid: s.id, at: s.at, astrologerId: it.astrologerId, position: it.position, label, features: it.features });
    }
    if (positive) positiveQueries++;
  }
  return { featureNames: ML_FEATURE_NAMES, featureVersion: ML_FEATURE_VERSION, rows, queries: usable.length, positiveQueries, skipped, from, to };
}
