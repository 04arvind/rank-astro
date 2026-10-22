"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import type { RankedAstrologer } from "@/types/ranking";
import ConsultDialog from "./ConsultDialog";
import RankingExplanation from "./RankignExplanation";

interface AstrologerCardProps {
  item: RankedAstrologer;
  showRank?: boolean;
  showExplanation?: boolean;
  /** Short context label, e.g. "You consulted before". */
  highlight?: string;
  onSelect?: (astrologerId: string) => void;
  /** Topic / language the user is browsing by, passed on with a booking. */
  consultContext?: { topic?: string; language?: string };
}

export default function AstrologerCard({
  item,
  showRank = true,
  showExplanation = false,
  highlight,
  onSelect,
  consultContext,
}: AstrologerCardProps) {
  const { astrologer: a, rank, reasons } = item;
  const [consulting, setConsulting] = useState(false);

  return (
    <article className="relative flex h-full flex-col gap-3 overflow-hidden rounded-2xl border border-white/70 bg-white/75 p-4 shadow-[0_10px_30px_-18px_rgba(61,37,114,0.45)] ring-1 ring-celestial-900/5 backdrop-blur-md transition duration-300 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-18px_rgba(61,37,114,0.55)]">
      {/* Hairline gold-to-lavender sheen along the top edge. */}
      <span aria-hidden="true" className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-gold-300 to-transparent opacity-70" />

      {highlight && (
        <p className="-mb-1 flex items-center gap-1 self-start rounded-full border border-gold-300/60 bg-gold-100/70 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-gold-600">
          <span aria-hidden="true">✦</span>
          {highlight}
        </p>
      )}
      <header className="flex items-start gap-3">
        <div className="relative shrink-0 rounded-full bg-gradient-to-br from-gold-300 via-lavender-200 to-celestial-400 p-[2px]">
          {a.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.avatarUrl} alt={a.name} className="h-14 w-14 rounded-full border-2 border-white object-cover" />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-white bg-lavender-100 font-display text-2xl font-semibold text-celestial-700">
              {a.name.charAt(0)}
            </div>
          )}
          <span
            title={a.isOnline ? "Online" : "Offline"}
            className={`absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white ${
              a.isOnline ? "bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.25)]" : "bg-zinc-300"
            }`}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {showRank && <span className="text-xs font-semibold text-celestial-400">#{rank}</span>}
            <h3 className="truncate font-display text-lg font-semibold leading-tight text-celestial-900">{a.name}</h3>
          </div>
          <p className="mt-0.5 text-sm text-celestial-800/80">
            {a.rating !== null ? (
              <>
                <span className="text-gold-400">★</span> {a.rating.toFixed(1)}{" "}
                <span className="text-celestial-800/50">({a.reviewCount} reviews)</span>
              </>
            ) : (
              <span className="text-celestial-800/50">New · no reviews yet</span>
            )}
            {a.experienceYears !== null && ` · ${a.experienceYears}+ yrs exp`}
          </p>
          {a.tagline && <p className="truncate text-xs text-celestial-800/60">{a.tagline}</p>}
          {a.languages.length > 0 && (
            <p className="truncate text-sm capitalize text-celestial-800/60">{a.languages.join(", ")}</p>
          )}
        </div>

        <div className="shrink-0 rounded-xl bg-lavender-50/80 px-2.5 py-1.5 text-right ring-1 ring-lavender-200/70">
          <p className="font-display text-lg font-bold leading-none text-celestial-700">₹{a.pricePerMinute}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-celestial-800/50">per min</p>
        </div>
      </header>

      {a.categories.length + a.specializations.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {[...a.categories, ...a.specializations].map((c) => (
            <li key={c} className="rounded-full border border-lavender-200 bg-lavender-50/80 px-2.5 py-0.5 text-xs capitalize text-celestial-700">
              {c}
            </li>
          ))}
        </ul>
      )}

      {showExplanation && <RankingExplanation reasons={reasons} />}

      {onSelect && (
        <button
          type="button"
          onClick={() => {
            onSelect(a.id);
            setConsulting(true);
          }}
          className={`mt-auto rounded-xl px-4 py-2.5 text-sm font-medium tracking-wide transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celestial-500 ${
            a.isOnline
              ? "bg-gradient-to-r from-celestial-600 via-celestial-700 to-celestial-800 text-white shadow-[0_8px_20px_-10px_rgba(82,51,150,0.8)] hover:brightness-110"
              : "border border-celestial-400/40 bg-ivory-50/70 text-celestial-700 hover:border-celestial-500 hover:bg-lavender-50"
          }`}
        >
          {a.isOnline ? "Consult now" : "Offline · Schedule call"}
        </button>
      )}

      {/* Portalled: the card's blur/transform (and the column's scroll box) would otherwise trap the fixed overlay. */}
      {consulting && createPortal(<ConsultDialog astrologer={a} context={consultContext} onClose={() => setConsulting(false)} />, document.body)}
    </article>
  );
}
