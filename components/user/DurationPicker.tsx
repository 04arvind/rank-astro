"use client";

import { useEffect, useState } from "react";
import type { DurationMinutes, DurationOffer, OfferAvatar } from "@/lib/consultation/offers";
import BookingDialog, { type BookingOrder } from "./BookingDialog";

interface DurationPickerProps {
  offers: DurationOffer[];
  /** Called when a duration card is chosen; wire the duration-selection action here. */
  onSelect?: (minutes: DurationMinutes) => void;
}

interface CardStyle {
  tag: string;
  description: string;
  /** Moon illumination 0..1: the phase grows with the length of the consultation. */
  phase: number;
  halo: string;
  moon: string;
  chip: string;
  selected: string;
  glow: string;
}

// Full class strings (not built dynamically) so Tailwind can see them.
const CARD: Record<DurationMinutes, CardStyle> = {
  3: {
    tag: "Quick",
    description: "Quick answers for pressing questions",
    phase: 0.25,
    halo: "from-rose-100/90 via-rose-50/60",
    moon: "text-rose-300",
    chip: "bg-rose-50 text-rose-700 ring-rose-200/80",
    selected: "ring-2 ring-rose-300",
    glow: "hover:shadow-[0_24px_50px_-24px_rgba(244,114,182,0.55)]",
  },
  5: {
    tag: "Focused",
    description: "Deeper insights for better decisions",
    phase: 0.5,
    halo: "from-emerald-100/80 via-emerald-50/50",
    moon: "text-emerald-300",
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/80",
    selected: "ring-2 ring-emerald-300",
    glow: "hover:shadow-[0_24px_50px_-24px_rgba(52,211,153,0.5)]",
  },
  10: {
    tag: "Detailed",
    description: "Detailed guidance for important questions",
    phase: 0.75,
    halo: "from-sky-100/90 via-sky-50/60",
    moon: "text-sky-300",
    chip: "bg-sky-50 text-sky-700 ring-sky-200/80",
    selected: "ring-2 ring-sky-300",
    glow: "hover:shadow-[0_24px_50px_-24px_rgba(56,189,248,0.5)]",
  },
  30: {
    tag: "In-depth",
    description: "In-depth consultation for multiple concerns",
    phase: 1,
    halo: "from-amber-100/90 via-amber-50/60",
    moon: "text-amber-300",
    chip: "bg-amber-50 text-amber-700 ring-amber-200/80",
    selected: "ring-2 ring-amber-300",
    glow: "hover:shadow-[0_24px_50px_-24px_rgba(251,191,36,0.55)]",
  },
};

const AVATAR_TINTS = [
  "from-lavender-200 to-rose-100",
  "from-gold-100 to-lavender-100",
  "from-sky-100 to-lavender-200",
  "from-emerald-100 to-ivory-200",
  "from-rose-100 to-gold-100",
];

const HONORIFIC = /^(astro|acharya|acharyaa|dr\.?|pt\.?|pandit|guru|shri|sri|smt\.?)$/i;

function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => w && !HONORIFIC.test(w));
  const pick = words.length ? words : name.split(/\s+/);
  return (pick[0]?.[0] ?? "") + (pick.length > 1 ? (pick[pick.length - 1][0] ?? "") : "");
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const perMin = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(1)}/min`;

/**
 * A moon at the given illumination (0 new … 1 full), lit from the right.
 * Outer edge is a half circle; the terminator is an ellipse whose width
 * shrinks to 0 at the half moon and bows left past it (gibbous).
 */
function Moon({ phase, className }: { phase: number; className: string }) {
  const c = 24;
  const r = 15;
  const rx = Math.abs(1 - 2 * phase) * r;
  const sweep = phase > 0.5 ? 1 : 0;
  const lit =
    phase >= 1
      ? `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c} ${c + r} A ${r} ${r} 0 1 1 ${c} ${c - r} Z`
      : `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${rx} ${r} 0 0 ${sweep} ${c} ${c - r} Z`;
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      {/* Faint orbit and the unlit disc. */}
      <circle cx={c} cy={c} r={22} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={0.6} strokeDasharray="1.5 3" />
      <circle cx={c} cy={c} r={r} fill="currentColor" fillOpacity={0.18} />
      <path d={lit} fill="currentColor" />
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeOpacity={0.6} strokeWidth={0.8} />
    </svg>
  );
}

function AvatarStack({ avatars, extra }: { avatars: OfferAvatar[]; extra: number }) {
  return (
    <span className="flex items-center -space-x-2.5">
      {avatars.map((a, i) => (
        <span
          key={a.id}
          title={a.name}
          className={`relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br ring-2 ring-white shadow-sm ${AVATAR_TINTS[i % AVATAR_TINTS.length]}`}
          style={{ zIndex: avatars.length - i }}
        >
          {a.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="font-display text-sm font-semibold uppercase text-celestial-800">{initials(a.name)}</span>
          )}
        </span>
      ))}
      {extra > 0 && (
        <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white text-xs font-semibold text-celestial-700 ring-2 ring-white shadow-sm">
          +{extra}
        </span>
      )}
    </span>
  );
}

/** Confirmation after the booking dialog closes itself: paid, booked, and what happens next. */
function BookedToast({ order, onDismiss }: { order: BookingOrder; onDismiss: () => void }) {
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md motion-safe:animate-rise sm:bottom-6">
      <div className="flex items-start gap-3 rounded-3xl border border-emerald-200 bg-white/95 p-4 shadow-[0_20px_50px_-20px_rgba(42,26,82,0.6)] backdrop-blur-md">
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-lg text-emerald-600 ring-1 ring-emerald-200">
          ✓
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-700">Payment received · Booked</p>
          <p className="mt-0.5 font-display text-lg font-semibold leading-snug text-celestial-900">
            {order.minutes}-min consultation · {rupees(order.amount)}
          </p>
          <p className="text-sm text-celestial-800/70">
            {order.mode === "instant" ? "Your astrologer will call you within 10-15 minutes." : `Your astrologer will call you on ${order.label}.`}
          </p>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 rounded-full p-1 text-xl leading-none text-celestial-800/60 hover:bg-lavender-50 hover:text-celestial-900">
          ×
        </button>
      </div>
    </div>
  );
}

/** Four consultation-length cards; each whole card is the button. */
export default function DurationPicker({ offers, onSelect }: DurationPickerProps) {
  const [selected, setSelected] = useState<DurationMinutes | null>(null);
  const [booking, setBooking] = useState<DurationOffer | null>(null);
  /** The order just paid and booked; the dialog closes itself and this confirms it. */
  const [booked, setBooked] = useState<BookingOrder | null>(null);

  useEffect(() => {
    if (!booked) return;
    const t = setTimeout(() => setBooked(null), 12_000);
    return () => clearTimeout(t);
  }, [booked]);

  return (
    <>
      <div role="group" aria-label="Consultation duration" className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        {offers.map((offer) => {
          const s = CARD[offer.minutes];
          const active = selected === offer.minutes;
          const available = offer.experts > 0 && offer.totalFrom !== null;
          return (
            <button
              key={offer.minutes}
              type="button"
              aria-pressed={active}
              disabled={!available}
              data-minutes={offer.minutes}
              aria-haspopup="dialog"
              onClick={() => {
                setSelected(offer.minutes);
                onSelect?.(offer.minutes);
                setBooking(offer);
              }}
              className={`group relative flex touch-manipulation flex-col overflow-hidden rounded-[28px] border border-white/80 bg-white/80 text-left shadow-[0_18px_40px_-28px_rgba(61,37,114,0.45)] backdrop-blur-xl transition duration-300 ease-out focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celestial-500 enabled:hover:-translate-y-1 enabled:active:translate-y-0 enabled:active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-60 ${s.glow} ${
                active ? s.selected : "ring-1 ring-celestial-900/5"
              }`}
            >
              {/* Pastel halo with the moon and a scatter of stars. */}
              <span className={`relative block bg-gradient-to-b to-transparent px-6 pb-4 pt-6 ${s.halo}`}>
                <span aria-hidden="true" className="absolute right-16 top-5 text-[10px] text-gold-400/70">✦</span>
                <span aria-hidden="true" className="absolute right-8 top-16 text-[7px] text-gold-400/60">✦</span>
                <span aria-hidden="true" className="absolute right-24 top-12 h-0.5 w-0.5 rounded-full bg-celestial-400/50" />
                <span className="flex items-start justify-between">
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.18em] ring-1 ${s.chip}`}>{s.tag}</span>
                  <Moon phase={s.phase} className={`h-12 w-12 transition duration-500 group-hover:rotate-12 group-hover:scale-110 ${s.moon}`} />
                </span>
                <span className="mt-2 flex items-baseline gap-2">
                  <span className="font-display text-6xl font-semibold leading-none tracking-tight text-celestial-900">{offer.minutes}</span>
                  <span className="text-sm font-medium uppercase tracking-[0.2em] text-celestial-800/60">minutes</span>
                </span>
                <span className="mt-2 block min-h-10 text-sm leading-snug text-celestial-800/75">{s.description}</span>
              </span>

              <span className="flex flex-1 flex-col gap-5 px-6 pb-6 pt-2">
                {/* Price */}
                <span className="flex items-end justify-between gap-3 border-t border-dashed border-lavender-200 pt-4">
                  <span className="block">
                    <span className="block text-[11px] uppercase tracking-[0.18em] text-celestial-800/50">Total from</span>
                    <span className="font-display text-3xl font-bold leading-none text-celestial-900">
                      {offer.totalFrom !== null ? rupees(offer.totalFrom) : "—"}
                    </span>
                  </span>
                  {offer.perMinuteFrom !== null && (
                    <span className="rounded-full bg-ivory-100 px-3 py-1 text-xs font-medium text-celestial-700 ring-1 ring-gold-300/50">
                      {perMin(offer.perMinuteFrom)}
                    </span>
                  )}
                </span>

                {/* Who's available */}
                <span className="flex items-center justify-between gap-3">
                  <AvatarStack avatars={offer.avatars} extra={Math.max(0, offer.experts - offer.avatars.length)} />
                  <span className="block text-right text-xs leading-tight">
                    <span className="block font-semibold text-celestial-900">{offer.experts} experts</span>
                    {offer.onlineNow > 0 ? (
                      <span className="mt-0.5 flex items-center justify-end gap-1 text-emerald-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        {offer.onlineNow} online now
                      </span>
                    ) : (
                      <span className="mt-0.5 block text-celestial-800/50">available to book</span>
                    )}
                  </span>
                </span>

                {/* CTA */}
                <span className="mt-auto flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-celestial-700 to-celestial-500 px-5 py-3 text-sm font-semibold tracking-wide text-white shadow-[0_12px_24px_-14px_rgba(82,51,150,0.9)] transition group-hover:from-celestial-800 group-hover:to-celestial-600 group-active:brightness-95">
                  {available ? (active ? "Selected" : "Book Now") : "Unavailable"}
                  <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
                    {active ? "✓" : "→"}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {booking && (
        <BookingDialog
          offer={booking}
          tag={CARD[booking.minutes].tag}
          emblem={<Moon phase={CARD[booking.minutes].phase} className={`h-14 w-14 ${CARD[booking.minutes].moon}`} />}
          onClose={() => setBooking(null)}
          onBooked={setBooked}
        />
      )}
      {booked && <BookedToast order={booked} onDismiss={() => setBooked(null)} />}
    </>
  );
}
