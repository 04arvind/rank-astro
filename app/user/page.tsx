import Link from "next/link";
import { connection } from "next/server";
import bgImg from "@/assets/bg_img.png";
import heroImg from "@/assets/home_bg_img.png";
import { Sparkle, StarRule } from "@/components/home/Celestial";
import Hero from "@/components/home/Hero";
import ServiceCard, { type ServiceCardProps } from "@/components/home/ServiceCard";
import { config } from "@/config";
import { getHomeHighlights, type ServiceId } from "@/lib/consultation/highlights";
import { display } from "../_components/fonts";

export const metadata = { title: "Home" };

type ServiceCopy = Omit<ServiceCardProps, "experts" | "fromPerMinute" | "offset">;

// Presentation for each service; counts and prices come from getHomeHighlights().
const SERVICES: Record<ServiceId, ServiceCopy> = {
  vedic: {
    title: "Vedic Astrology",
    specialization: "Kundli · Dasha · Remedies",
    description: "A complete reading of your birth chart — the periods ahead of you and the remedies that support them.",
    symbol: "☉",
    image: heroImg,
    focus: "76% 44%",
    zoom: 1.9,
  },
  love: {
    title: "Love & Relationships",
    specialization: "Compatibility · Timing · Healing",
    description: "Understand the connection you share, what it needs, and when the heart's questions find their answers.",
    symbol: "♀",
    image: bgImg,
    focus: "20% 34%",
    zoom: 1.35,
  },
  career: {
    title: "Career & Finance",
    specialization: "Growth · Wealth · Direction",
    description: "Clarity on the right moves, the right moments, and the path your work and wealth are meant to take.",
    symbol: "♄",
    image: heroImg,
    focus: "60% 84%",
    zoom: 1.7,
  },
  marriage: {
    title: "Marriage & Compatibility",
    specialization: "Kundli matching · Muhurat",
    description: "Thoughtful kundli matching and auspicious timing, so a new chapter begins on the strongest footing.",
    symbol: "⚭",
    image: bgImg,
    focus: "79% 16%",
    zoom: 2.4,
  },
  numerology: {
    title: "Numerology",
    specialization: "Name · Birth number · Lucky dates",
    description: "The quiet patterns in your name and birth date, and how to work with the numbers that favour you.",
    symbol: "✧",
    image: heroImg,
    focus: "48% 20%",
    zoom: 1.9,
  },
  palmistry: {
    title: "Palmistry",
    specialization: "Life line · Heart line · Destiny",
    description: "A calm, careful reading of the lines you carry — your temperament, your strengths, and your path.",
    symbol: "☽",
    image: heroImg,
    focus: "90% 72%",
    zoom: 2.2,
  },
};

const STEPS = [
  { n: "I", title: "Choose your guidance", body: "Pick a service or browse astrologers by language, topic and price." },
  { n: "II", title: "Meet a verified expert", body: "Every astrologer is verified, with their per-minute rate shown upfront." },
  { n: "III", title: "Talk privately", body: "Call now or schedule a slot. You're billed per second, only while connected." },
];

function languageList(ids: string[]): string {
  const labels = ids.map((id) => config.catalog.languages.find((l) => l.id === id)?.label ?? id);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} & ${labels.at(-1)}`;
}

export default async function HomePage() {
  // Stats, counts and prices come from the live astrologer pool.
  await connection();
  const h = await getHomeHighlights();

  const stats = [
    { value: String(h.verifiedAstrologers), label: "Verified astrologers" },
    { value: h.averageRating !== null ? `${h.averageRating.toFixed(1)}★` : "New", label: "Average rating" },
    { value: String(h.languages.length), label: languageList(h.languages) || "Languages" },
    { value: h.fromPerMinute !== null ? `₹${h.fromPerMinute}` : "—", label: "Per minute, from" },
  ];

  return (
    <div className={`${display.variable} flex-1 bg-cream-50 text-espresso-900`}>
      <Hero experts={h.verifiedAstrologers} fromPerMinute={h.fromPerMinute} onlineNow={h.onlineNow} />

      {/* Trust capsule, overlapping the hero's fade. */}
      <section aria-label="At a glance" className="relative z-10 mx-auto -mt-16 max-w-5xl px-5">
        <dl className="grid grid-cols-2 gap-y-6 rounded-[36px] border border-champagne-300/70 bg-cream-50/95 px-6 py-7 shadow-[0_30px_60px_-40px_rgba(87,69,53,0.6)] backdrop-blur md:grid-cols-4 md:rounded-full md:px-10">
          {stats.map((s, i) => (
            <div key={s.label} className={`flex flex-col items-center text-center ${i > 0 ? "md:border-l md:border-champagne-300/50" : ""}`}>
              <dt className="order-2 mt-1 text-[11px] uppercase tracking-[0.2em] text-espresso-500">{s.label}</dt>
              <dd className="order-1 font-display text-3xl font-semibold text-espresso-900">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Services */}
      <section id="services" className="mx-auto max-w-7xl px-5 pb-12 pt-24 sm:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.35em] text-champagne-600">Our services</p>
          <h2 className="mt-4 font-display text-4xl font-medium leading-tight text-espresso-900 sm:text-5xl">
            Guidance for every <span className="italic text-champagne-600">chapter of life</span>
          </h2>
          <StarRule className="mx-auto mt-6 w-40 text-champagne-400" />
          <p className="mt-6 text-base leading-relaxed text-espresso-700/85">
            From the first question of the heart to the biggest decisions of a career, speak with astrologers who specialise in exactly
            what you&apos;re asking.
          </p>
        </div>

        <div className="mt-16 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {h.services.map((s, i) => (
            <ServiceCard key={s.id} {...SERVICES[s.id]} experts={s.experts} fromPerMinute={s.fromPerMinute} offset={i % 3 === 1} />
          ))}
        </div>
      </section>

      {/* How it works: three medallions on a dotted orbit. */}
      <section className="relative mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <h2 className="text-center font-display text-4xl font-medium text-espresso-900">How it works</h2>
        <div className="relative mt-14">
          <svg aria-hidden="true" viewBox="0 0 1000 120" preserveAspectRatio="none" className="absolute inset-x-[12%] top-6 hidden h-24 w-[76%] text-champagne-300 md:block">
            <path d="M0 60 C 250 -20, 750 140, 1000 60" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 7" strokeLinecap="round" />
          </svg>
          <ol className="relative grid gap-12 md:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.n} className="flex flex-col items-center text-center">
                <span className="flex h-24 w-24 items-center justify-center rounded-full border border-champagne-400/70 bg-gradient-to-b from-peach-100 to-cream-50 font-display text-3xl italic text-champagne-600 shadow-[0_18px_40px_-24px_rgba(156,118,64,0.7)] ring-8 ring-cream-50">
                  {step.n}
                </span>
                <h3 className="mt-6 font-display text-2xl font-medium text-espresso-900">{step.title}</h3>
                <p className="mt-2 max-w-xs text-sm leading-relaxed text-espresso-700/85">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Closing invitation. */}
      <section className="px-5 pb-24 sm:px-8">
        <div className="relative mx-auto max-w-5xl overflow-hidden rounded-[48px] border border-champagne-300/70 bg-peach-100/70 px-8 py-16 text-center md:rounded-full md:px-20">
          <Sparkle className="absolute left-[10%] top-8 h-4 w-4 text-champagne-400 motion-safe:animate-twinkle" />
          <Sparkle className="absolute bottom-10 right-[12%] h-3 w-3 text-champagne-400 motion-safe:animate-twinkle [animation-delay:1.8s]" />
          <h2 className="font-display text-4xl font-medium leading-tight text-espresso-900 sm:text-5xl">
            Your stars have something <span className="italic text-champagne-600">to say</span>
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-base text-espresso-700/85">Begin with a single question. We&apos;ll connect you with someone who can help.</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/user/astrologers"
              className="inline-flex items-center gap-3 rounded-full bg-espresso-900 px-7 py-3.5 text-sm font-semibold tracking-wide text-cream-50 transition duration-300 hover:bg-espresso-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-espresso-700 active:scale-[0.98]"
            >
              Consult Now <span aria-hidden="true">→</span>
            </Link>
            <Link
              href="/user/consult"
              className="inline-flex items-center rounded-full border border-espresso-900/25 px-7 py-3.5 text-sm font-medium tracking-wide text-espresso-900 transition duration-300 hover:border-espresso-900/60 hover:bg-cream-50/70 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-espresso-700 active:scale-[0.98]"
            >
              Explore Astrologers
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
