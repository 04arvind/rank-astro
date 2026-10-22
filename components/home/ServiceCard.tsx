import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import { glyph, Sparkle, StarRule } from "./Celestial";

export interface ServiceCardProps {
  title: string;
  /** Small caps line above the title, e.g. "Kundli · Dasha · Remedies". */
  specialization: string;
  description: string;
  /** Astrological glyph shown in the medallion. */
  symbol: string;
  image: StaticImageData;
  /** Which part of the artwork shows through the arch, and how close. */
  focus: string;
  zoom: number;
  experts: number;
  fromPerMinute: number | null;
  /** Nudges alternate cards down for an organic, staggered rhythm. */
  offset?: boolean;
}

/**
 * Arched "window" card: the artwork sits in a cathedral-arch frame with a
 * hairline inner frame, fades into cream, and a gold medallion bridges the
 * image and the text.
 */
export default function ServiceCard({
  title,
  specialization,
  description,
  symbol,
  image,
  focus,
  zoom,
  experts,
  fromPerMinute,
  offset = false,
}: ServiceCardProps) {
  return (
    <article
      className={`group relative flex flex-col rounded-t-[999px] rounded-b-[40px] border border-champagne-300/70 bg-cream-50/90 p-2.5 shadow-[0_30px_60px_-40px_rgba(87,69,53,0.55)] transition duration-500 ease-out hover:-translate-y-1.5 hover:border-champagne-400/80 hover:shadow-[0_40px_70px_-38px_rgba(156,118,64,0.6)] ${
        offset ? "lg:mt-14" : ""
      }`}
    >
      {/* Arched artwork window. */}
      <div className="relative aspect-[5/5.2] overflow-hidden rounded-t-[999px] rounded-b-[28px]">
        <div className="absolute inset-0 transition-transform duration-[1200ms] ease-out group-hover:scale-[1.06]">
          <Image
            src={image}
            alt=""
            fill
            sizes="100vw"
            placeholder="blur"
            className="object-cover"
            style={{ objectPosition: focus, transform: `scale(${zoom})`, transformOrigin: focus }}
          />
        </div>
        {/* Blend the art into the card, plus a hairline inner arch. */}
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-b from-transparent to-cream-50/95" />
        <div aria-hidden="true" className="absolute inset-3 rounded-t-[999px] rounded-b-[20px] border border-cream-50/60" />
        <Sparkle className="absolute left-1/2 top-7 h-3 w-3 -translate-x-1/2 text-cream-50/80 motion-safe:animate-twinkle" />
      </div>

      {/* Medallion bridging image and text. */}
      <div className="relative z-10 mx-auto -mt-9 flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full border border-champagne-400/70 bg-cream-50 font-display text-3xl text-champagne-600 shadow-[0_10px_24px_-14px_rgba(156,118,64,0.7)] ring-[6px] ring-cream-50 transition duration-500 group-hover:rotate-[20deg]">
        <span aria-hidden="true">{glyph(symbol)}</span>
      </div>

      <div className="flex flex-1 flex-col items-center px-6 pb-7 pt-4 text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-champagne-600">{specialization}</p>
        <h3 className="mt-2 font-display text-[1.75rem] font-medium leading-tight text-espresso-900">{title}</h3>
        <p className="mt-3 max-w-xs text-sm leading-relaxed text-espresso-700/85">{description}</p>

        <StarRule className="mt-6 w-full max-w-[12rem] text-champagne-400" />

        <p className="mt-4 text-sm text-espresso-700">
          {fromPerMinute !== null ? (
            <>
              From <span className="font-display text-xl font-semibold text-espresso-900">₹{fromPerMinute}</span>
              <span className="text-espresso-500">/min</span>
            </>
          ) : (
            <span className="text-espresso-500">Coming soon</span>
          )}
          <span aria-hidden="true" className="mx-2.5 text-champagne-400">·</span>
          <span className="text-espresso-500">
            {experts} {experts === 1 ? "expert" : "experts"}
          </span>
        </p>

        <Link
          href="/user/astrologers"
          aria-label={`Consult now: ${title}`}
          className="mt-6 inline-flex items-center gap-2 rounded-full border border-champagne-400/80 px-6 py-2.5 text-sm font-medium tracking-wide text-espresso-900 transition duration-300 hover:border-transparent hover:bg-champagne-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-champagne-400 active:scale-[0.98]"
        >
          Consult now
          <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
            →
          </span>
        </Link>
      </div>
    </article>
  );
}
