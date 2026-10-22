import Image from "next/image";
import Link from "next/link";
import heroImg from "@/assets/home_bg_img.png";
import { Constellation, Sparkle, ZODIAC } from "./Celestial";

// Twinkling stars over the open sky on the left of the image.
const STARS = [
  { top: "18%", left: "8%", size: "h-3 w-3", delay: "0s" },
  { top: "34%", left: "44%", size: "h-2 w-2", delay: "1.2s" },
  { top: "12%", left: "58%", size: "h-2.5 w-2.5", delay: "2.4s" },
  { top: "62%", left: "4%", size: "h-2 w-2", delay: "3.1s" },
  { top: "72%", left: "38%", size: "h-1.5 w-1.5", delay: "0.6s" },
];

export default function Hero() {
  return (
    <section className="relative isolate flex min-h-[620px] items-center overflow-hidden h-[86svh] max-h-[880px]">
      <Image
        src={heroImg}
        alt=""
        fill
        preload
        placeholder="blur"
        sizes="100vw"
        className="-z-20 object-cover object-[72%_center]"
      />
      {/* Scrims for legibility only: a soft wash behind the text, and a fade into the cream page below. */}
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-[#140e2a]/75 via-[#140e2a]/30 to-transparent md:via-[#140e2a]/10" />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-b from-transparent to-cream-50" />

      {STARS.map((s) => (
        <Sparkle
          key={`${s.top}-${s.left}`}
          className={`absolute text-champagne-200 motion-safe:animate-twinkle ${s.size}`}
          style={{ top: s.top, left: s.left, animationDelay: s.delay }}
        />
      ))}

      <div className="mx-auto w-full max-w-7xl px-5 sm:px-8">
        <div className="max-w-2xl motion-safe:animate-rise">
          <Constellation className="mb-6 h-10 w-auto text-champagne-300/80" />
          <p className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.35em] text-champagne-300">
            <span className="h-px w-8 bg-champagne-300/70" />
            Vedic wisdom · Modern guidance
          </p>
          <h1 className="mt-5 font-display text-5xl font-medium leading-[1.02] tracking-tight text-cream-50 sm:text-6xl lg:text-7xl">
            Find clarity in the <span className="italic text-champagne-300">language of the stars</span>
          </h1>
          <p className="mt-6 max-w-lg text-base leading-relaxed text-cream-100/85 sm:text-lg">
            Consult verified astrologers in Vedic astrology, numerology, palmistry and more — for love, career, marriage and the decisions
            that matter most. Privately, in Hindi or English.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link
              href="/user/astrologers"
              className="group inline-flex items-center gap-3 rounded-full bg-champagne-300 px-7 py-3.5 text-sm font-semibold tracking-wide text-espresso-900 shadow-[0_10px_40px_-10px_rgba(227,200,156,0.8)] transition duration-300 hover:bg-champagne-200 hover:shadow-[0_14px_50px_-8px_rgba(227,200,156,0.95)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-champagne-200 active:scale-[0.98]"
            >
              Consult Now
              <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
                →
              </span>
            </Link>
            <Link
              href="/user/consult"
              className="inline-flex items-center rounded-full border border-cream-50/45 bg-white/5 px-7 py-3.5 text-sm font-medium tracking-wide text-cream-50 backdrop-blur-sm transition duration-300 hover:border-cream-50/80 hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cream-50 active:scale-[0.98]"
            >
              Explore Astrologers
            </Link>
          </div>

          <p aria-hidden="true" className="mt-12 hidden gap-4 font-display text-lg text-champagne-200/55 sm:flex">
            {ZODIAC.map((z) => (
              <span key={z}>{z}</span>
            ))}
          </p>
        </div>
      </div>
    </section>
  );
}
