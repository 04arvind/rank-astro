import type { CallInput, ImpressionInput } from "@/lib/analytics/ingest";
import { ASTRO } from "./astrologers";
import { minutesAgo } from "./time";

/*
 * Provider fixtures:
 *  - RAW_FEEDS: raw records in each provider's own format, for adapter and
 *    normalization tests (fake names; contact columns carry obviously fake
 *    values to prove they're dropped).
 *  - TRAFFIC: recent impression/call patterns that put providers into
 *    known utilization states (balanced, over-exposed, saturated).
 */

export const PROVIDER_IDS = ["providerA", "providerB", "providerC"] as const;

// ---------------------------------------------------------------------------
// Raw feeds
// ---------------------------------------------------------------------------

/** Astropatri-style onboarding sheet rows (header-keyed). */
export const RAW_PROVIDER_A = [
  {
    "S.No": "1",
    Name: "Test Pandit One",
    Slot: "Meet Done",
    "Contact Number": "0000000000",
    "Email id": "fixture-one@example.invalid",
    "Per minute call": "100",
    "Call/chat Price (30 Min)": "3000",
    "per 5 min cost": "500",
    "Min call time": "15",
    Link: "https://astropatri.example/astrologer/test-pandit-one",
  },
  // Onboarding meeting pending → normalizes but is unverified.
  { Name: "Test Pandit Two", Slot: "tbd", "Per minute call": "45", "Min call time": "5", Link: "https://astropatri.example/consult/talk-to-astrologer/test-pandit-two" },
  // Missing price → rejected at the common-model stage.
  { Name: "Test Pandit Three", Slot: "Meet Done", "Per minute call": "", Link: "https://astropatri.example/astrologer/test-pandit-three" },
  // No link → id falls back to the slugified name.
  { Name: "Test Pandit Four", Slot: "MEET DONE", "Per minute call": "60" },
] as const;

/** Talk to Guruji-style bilingual panel rows. */
export const RAW_PROVIDER_B = [
  {
    "Name of the Expert": "Acharya Fixture Kumar",
    "Tag line": "20 years of experience. Vedic Astrology",
    "Category | tag": "Vedic Astrology | वैदिक ज्योतिष, Numerology | अंक ज्योतिष",
    "About the expert": "PENDING",
    "Expert Image": "PENDING",
    Expertise: "Vedic Astrology | वैदिक ज्योतिष",
    Tier: "T4",
    "Per Minute": "₹100/min",
    "Astrologer Charge (15 Min)": "₹750",
    "Final Price (15 Min)": "₹1500",
    "Astrologer Charge (30 Min)": "₹1500",
    "Final Price (30 Min)": "₹3000",
    Duration: "30 Minutes | 30 मिनट",
    "Year of experience": "20+ years | 20+ वर्ष",
    "Known languages": "Hindi | हिंदी, English | अंग्रेज़ी",
    "Consultation Mode": "Audio | ऑडियो, Video | वीडियो, Chat | चैट",
  },
  {
    "Name of the Expert": "Astro Fixture Range",
    "Category | tag": "Tarot | टैरो, Crystal Gazing | क्रिस्टल",
    Tier: "T2",
    "Per Minute": "₹50/min",
    "Final Price (15 Min)": "₹750",
    "Astrologer Charge (15 Min)": "₹375",
    "Year of experience": "3-5 years | 3-5 वर्ष",
    "Known languages": "Hindi | हिंदी, Klingon | क्लिंगन",
    "Consultation Mode": "Chat | चैट",
  },
] as const;

/** Provider C JSON API records (assumed schema, see lib/providers/providerC.ts). */
export const RAW_PROVIDER_C = [
  {
    astrologer_id: "C-900",
    display_name: "Fixture Tarot Reader",
    languages: ["English", "Hindi"],
    topics: ["Love", "Career"],
    skills: ["Tarot"],
    modes: ["chat", "call"],
    price_per_min: 30,
    payout_per_min: 18,
    rating: 4.6,
    review_count: 120,
    status: "online",
    is_verified: true,
    joined_at: "2025-12-20T00:00:00Z",
  },
  // Wrong type for price → rejected at the raw stage.
  { astrologer_id: "C-901", display_name: "Broken Record", price_per_min: "not-a-number" },
] as const;

export const RAW_FEEDS = {
  providerA: RAW_PROVIDER_A,
  providerB: RAW_PROVIDER_B,
  providerC: RAW_PROVIDER_C,
} as const;

/** What normalizing RAW_FEEDS must produce. */
export const RAW_FEED_EXPECTATIONS = {
  providerA: { accepted: ["providerA:test-pandit-one", "providerA:test-pandit-two", "providerA:test-pandit-four"], rejected: 1, unverified: ["providerA:test-pandit-two"] },
  providerB: { accepted: ["providerB:acharya-fixture-kumar", "providerB:astro-fixture-range"], rejected: 0, unmapped: ["languages:Klingon | क्लिंगन", "specializations:Crystal Gazing | क्रिस्टल"] },
  providerC: { accepted: ["providerC:c-900"], rejected: 1 },
} as const;

// ---------------------------------------------------------------------------
// Utilization / traffic presets
// ---------------------------------------------------------------------------

export type TrafficPreset = "balanced" | "providerB-overexposed" | "providerC-saturated";

/** Impressions within the last hour split across providers by share (top-10 positions). */
function recentImpressions(shares: Record<string, number>, total: number, tag: string): ImpressionInput[] {
  const representative: Record<string, string> = { providerA: ASTRO.arjun.id, providerB: ASTRO.meera.id, providerC: ASTRO.dev.id };
  const out: ImpressionInput[] = [];
  for (const [providerId, share] of Object.entries(shares)) {
    const n = Math.round(total * share);
    for (let i = 0; i < n; i++) {
      out.push({
        eventId: `traffic-${tag}-${providerId}-${i}`,
        timestamp: minutesAgo(1 + (i % 50)),
        astrologerId: representative[providerId],
        providerId,
        position: (i % 10) + 1,
        sessionId: `traffic-${tag}-${i % 40}`,
      });
    }
  }
  return out;
}

/** `concurrent` overlapping 30-minute calls on one provider, all ending a minute ago. */
function concurrentCalls(providerId: string, astrologerId: string, concurrent: number, price: number): CallInput[] {
  return Array.from({ length: concurrent }, (_, i) => ({
    callId: `traffic-busy-${providerId}-${i}`,
    userId: `traffic-caller-${i}`,
    astrologerId,
    providerId,
    status: "completed" as const,
    startedAt: minutesAgo(31),
    endedAt: minutesAgo(1),
    pricePerMinute: price,
  }));
}

export const TRAFFIC: Record<TrafficPreset, { description: string; impressions: ImpressionInput[]; calls: CallInput[] }> = {
  balanced: {
    description: "Top-slot exposure matches provider targets (40/35/25).",
    impressions: recentImpressions({ providerA: 0.4, providerB: 0.35, providerC: 0.25 }, 400, "balanced"),
    calls: [],
  },
  "providerB-overexposed": {
    description: "Provider B holds 80% of recent top slots; A and C are starved.",
    impressions: recentImpressions({ providerA: 0.1, providerB: 0.8, providerC: 0.1 }, 400, "b-over"),
    calls: [],
  },
  "providerC-saturated": {
    description: "Provider C is under-exposed but 70 of its 80 consultation lines are in use.",
    impressions: recentImpressions({ providerA: 0.45, providerB: 0.45, providerC: 0.1 }, 400, "c-sat"),
    calls: concurrentCalls("providerC", ASTRO.dev.id, 70, ASTRO.dev.pricing.perMinute),
  },
};
