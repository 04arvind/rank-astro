import { config } from "@/config";
import { clamp } from "@/lib/utils/math";
import type { Signal } from "../types";

const REASONS = { online: "Available now", busy: "On a call — short wait" } as const;

/** Astrologer status: online / busy / offline / unknown, scored from config. */
export const availabilityStatusSignal: Signal = {
  name: "availabilityStatus",
  audience: "user",
  compute({ astrologer: a }) {
    const { status } = a.availability;
    return {
      value: config.ranking.signals.availability.scores[status],
      reason: status === "online" || status === "busy" ? REASONS[status] : undefined,
      detail: { status },
    };
  },
};

/** Can take a call this minute: online and not on another call. */
export const callReadySignal: Signal = {
  name: "callReady",
  audience: "internal",
  compute({ astrologer: a }) {
    const { status } = a.availability;
    if (status === "unknown") return { value: null, detail: { status } };
    return { value: status === "online" ? 1 : 0, detail: { status } };
  },
};

/** Spare capacity at the astrologer's provider: 1 − utilization. */
export const providerCapacitySignal: Signal = {
  name: "providerCapacity",
  audience: "internal",
  compute({ astrologer: a }, { providers }) {
    const u = providers.get(a.providerId)?.utilization ?? null;
    return { value: u === null ? null : clamp(1 - u), detail: { utilization: u } };
  },
};
