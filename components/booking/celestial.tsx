"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { formatDay, formatSlot, formatTime, localMinuteOfDay } from "@/lib/booking/time";
import type { Schedule, Slot } from "@/types/booking";

/*
 * Shared pieces of the celestial booking dialogs (the /user duration
 * cards and the astrologer cards' Consult now): zodiac decoration, step
 * orbit, the live slot calendar and modal behaviour.
 */

const REFRESH_MS = 30_000;
export const VS = "︎"; // text presentation, so glyphs don't turn into emoji
const ZODIAC = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

type ApiError = { code?: string; message?: string };

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => null)) as { data?: T; error?: ApiError } | null;
  if (!res.ok || !body?.data) {
    throw Object.assign(new Error(body?.error?.message ?? "Something went wrong. Please try again."), { code: body?.error?.code });
  }
  return body.data;
}


/* ───────────────────────── decorative pieces ───────────────────────── */

/** Twelve-sign zodiac wheel; slowly turns unless the user prefers reduced motion. */
export function ZodiacWheel({ className }: { className: string }) {
  const c = 100;
  return (
    <svg viewBox="0 0 200 200" aria-hidden="true" className={className}>
      <circle cx={c} cy={c} r={96} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={0.8} />
      <circle cx={c} cy={c} r={78} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={0.6} />
      <circle cx={c} cy={c} r={40} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={0.6} strokeDasharray="1.5 3" />
      {ZODIAC.map((sign, i) => {
        const a = (i * 30 * Math.PI) / 180;
        const mid = a + Math.PI / 12;
        return (
          <g key={sign}>
            <line
              x1={c + 78 * Math.cos(a)}
              y1={c + 78 * Math.sin(a)}
              x2={c + 96 * Math.cos(a)}
              y2={c + 96 * Math.sin(a)}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={0.6}
            />
            <text
              x={c + 87 * Math.cos(mid)}
              y={c + 87 * Math.sin(mid)}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={10}
              fill="currentColor"
              fillOpacity={0.6}
            >
              {sign + VS}
            </text>
          </g>
        );
      })}
    </svg>
  );
}


/** Steps as planets on a shallow arc; `current` past the end marks all done. */
export function OrbitSteps({ steps, current }: { steps: readonly { id: string; label: string }[]; current: number }) {
  return (
    <ol className="relative mx-auto flex w-full max-w-xs items-start justify-between" aria-label="Booking steps">
      <svg viewBox="0 0 300 30" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-x-5 top-0 h-6 w-[calc(100%-2.5rem)] text-gold-400">
        <path d="M 0 22 Q 150 -6 300 22" fill="none" stroke="currentColor" strokeWidth={1.2} strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
      </svg>
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={s.id} className={`relative flex w-16 flex-col items-center gap-1 ${i === 1 ? "-mt-2" : ""}`} aria-current={state === "current" ? "step" : undefined}>
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition duration-300 ${
                state === "current"
                  ? "bg-gradient-to-br from-celestial-600 to-celestial-800 text-white shadow-[0_0_0_4px_rgba(209,171,98,0.25),0_8px_18px_-8px_rgba(82,51,150,0.9)]"
                  : state === "done"
                    ? "bg-gold-300 text-celestial-900"
                    : "bg-white text-celestial-800/50 ring-1 ring-lavender-200"
              }`}
            >
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className={`text-[11px] font-medium uppercase tracking-[0.16em] ${state === "todo" ? "text-celestial-800/45" : "text-celestial-800"}`}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}


export function SectionTitle({ glyph, children, hint }: { glyph: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h3 className="flex items-center gap-2 font-display text-xl font-semibold text-celestial-900">
        <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full bg-gold-100 text-sm text-gold-600 ring-1 ring-gold-300/60">
          {glyph + VS}
        </span>
        {children}
      </h3>
      {hint && <span className="text-xs text-celestial-800/55">{hint}</span>}
    </div>
  );
}


/* ───────────────────────────── calendar ───────────────────────────── */

interface MonthCell {
  date: string;
  day: number;
}

/** Month grids covering the schedule's days, as [year, month, leading blanks, cells]. */
function monthsFor(schedule: Schedule) {
  const first = schedule.days[0]?.date;
  const last = schedule.days[schedule.days.length - 1]?.date;
  if (!first || !last) return [];
  const [fy, fm] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  const months: { year: number; month: number; lead: number; cells: MonthCell[] }[] = [];
  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm); m === 12 ? ((m = 1), y++) : m++) {
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    months.push({
      year: y,
      month: m,
      lead,
      cells: Array.from({ length: count }, (_, i) => ({
        date: `${y}-${String(m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`,
        day: i + 1,
      })),
    });
  }
  return months;
}

const PERIODS = [
  { id: "morning", label: "Morning", glyph: "☼", until: 12 * 60 },
  { id: "afternoon", label: "Afternoon", glyph: "☉", until: 17 * 60 },
  { id: "evening", label: "Evening", glyph: "☾", until: 24 * 60 },
] as const;

const SLOT_HINT: Record<Slot["status"], string> = {
  available: "Available",
  unavailable: "Unavailable",
  userBusy: "You have another call booked then",
  yours: "Already booked by you",
};

interface ScheduleStepProps {
  schedule: Schedule | null;
  loadError: string | null;
  date: string | null;
  slot: number | null;
  now: number;
  onDate: (date: string) => void;
  onSlot: (startAt: number) => void;
  onRetry: () => void;
  /** Banner text once a slot is picked; defaults to the slot's date and time. */
  describe?: (startAt: number) => string;
}

export const bookable = (s: Slot, now: number) => s.status === "available" && s.startAt > now;

export function ScheduleStep({ schedule, loadError, date, slot, now, onDate, onSlot, onRetry, describe }: ScheduleStepProps) {
  const [paged, setPaged] = useState<number | null>(null);
  const months = useMemo(() => (schedule ? monthsFor(schedule) : []), [schedule]);
  // Show the month holding the picked date until the user pages.
  const dateMonth = date ? months.findIndex((m) => date.startsWith(`${m.year}-${String(m.month).padStart(2, "0")}`)) : -1;
  const monthIndex = paged ?? Math.max(0, dateMonth);
  const setMonthIndex = (f: (i: number) => number) => setPaged(f(monthIndex));
  const byDate = useMemo(() => new Map((schedule?.days ?? []).map((d) => [d.date, d])), [schedule]);

  if (!schedule) {
    return (
      <div className="flex flex-col items-center py-10 text-center" aria-live="polite">
        {loadError ? (
          <>
            <p className="max-w-xs text-sm text-rose-700">{loadError}</p>
            <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded-full px-6 text-sm font-semibold text-celestial-700 ring-1 ring-celestial-400/50 hover:bg-lavender-50">
              Try again
            </button>
          </>
        ) : (
          <>
            <ZodiacWheel className="h-20 w-20 text-celestial-500 motion-safe:animate-spin [animation-duration:6s]" />
            <p className="mt-3 text-sm text-celestial-800/70">Reading the stars for open slots…</p>
          </>
        )}
      </div>
    );
  }

  const offset = schedule.utcOffsetMinutes;
  const month = months[Math.min(monthIndex, months.length - 1)];
  const today = schedule.days[0]?.date;
  const day = date ? byDate.get(date) : undefined;
  const slots = (day?.slots ?? []).filter((s) => s.endAt > now);

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* Calendar: a round lunar dial of dates. */}
      <div className="relative overflow-hidden rounded-[36px] bg-gradient-to-b from-white/95 to-lavender-50/90 p-4 ring-1 ring-lavender-200/80 sm:p-5">
        <ZodiacWheel className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 text-lavender-300/70" />
        {month && (
          <div className="relative mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setMonthIndex((i) => Math.max(0, i - 1))}
              disabled={monthIndex === 0}
              aria-label="Previous month"
              className="flex h-11 w-11 items-center justify-center rounded-full text-lg text-celestial-700 transition hover:bg-lavender-100 disabled:opacity-30"
            >
              ‹
            </button>
            <p className="font-display text-lg font-semibold text-celestial-900" aria-live="polite">
              {MONTHS[month.month - 1]} {month.year}
            </p>
            <button
              type="button"
              onClick={() => setMonthIndex((i) => Math.min(months.length - 1, i + 1))}
              disabled={monthIndex >= months.length - 1}
              aria-label="Next month"
              className="flex h-11 w-11 items-center justify-center rounded-full text-lg text-celestial-700 transition hover:bg-lavender-100 disabled:opacity-30"
            >
              ›
            </button>
          </div>
        )}
        <div className="relative grid grid-cols-7 gap-y-1 text-center" role="grid" aria-label="Choose a date">
          {WEEKDAYS.map((w, i) => (
            <span key={i} className="pb-1 text-[11px] font-medium uppercase tracking-widest text-celestial-800/45" aria-hidden="true">
              {w}
            </span>
          ))}
          {month && Array.from({ length: month.lead }, (_, i) => <span key={`lead-${i}`} />)}
          {month?.cells.map((cell) => {
            const d = byDate.get(cell.date);
            const free = d ? d.slots.filter((s) => bookable(s, now)).length : 0;
            const enabled = free > 0;
            const selected = cell.date === date;
            return (
              <span key={cell.date} className="flex justify-center">
                <button
                  type="button"
                  disabled={!enabled}
                  aria-pressed={selected}
                  aria-label={`${cell.day} ${MONTHS[month.month - 1]}${enabled ? `, ${free} slots open` : ", unavailable"}`}
                  onClick={() => onDate(cell.date)}
                  className={`relative flex h-11 w-11 flex-col items-center justify-center rounded-full text-sm transition duration-200 ${
                    selected
                      ? "bg-gradient-to-br from-celestial-600 to-celestial-800 font-semibold text-white shadow-[0_0_0_3px_rgba(209,171,98,0.35),0_10px_20px_-10px_rgba(82,51,150,0.9)]"
                      : enabled
                        ? "font-medium text-celestial-900 hover:bg-lavender-100 active:scale-95"
                        : "cursor-not-allowed text-celestial-800/25"
                  } ${cell.date === today && !selected ? "ring-1 ring-gold-400" : ""}`}
                >
                  {cell.day}
                  {enabled && (
                    <span aria-hidden="true" className={`absolute bottom-1 h-1 w-1 rounded-full ${selected ? "bg-gold-300" : "bg-gold-400"}`} />
                  )}
                </button>
              </span>
            );
          })}
        </div>
        <p className="relative mt-3 flex items-center justify-center gap-3 text-[11px] text-celestial-800/55">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-gold-400" /> Open slots
          </span>
          <span className="flex items-center gap-1">
            <span className="h-3 w-3 rounded-full ring-1 ring-gold-400" /> Today
          </span>
        </p>
      </div>

      {/* Time slots, grouped by the sun's position. */}
      <div>
        <p className="mb-3 text-xs text-celestial-800/60">
          {schedule.slotMinutes}-min slots · times in {schedule.timeZoneLabel}
        </p>
        {!day ? (
          <p className="rounded-[28px] bg-white/70 px-5 py-8 text-center text-sm text-celestial-800/60 ring-1 ring-lavender-200/70">Pick a date to see open times.</p>
        ) : slots.every((s) => !bookable(s, now)) ? (
          <p className="rounded-[28px] bg-white/70 px-5 py-8 text-center text-sm text-celestial-800/60 ring-1 ring-lavender-200/70">No slots left on this day.</p>
        ) : (
          <div className="space-y-4 md:max-h-80 md:overflow-y-auto md:pr-1">
            {PERIODS.map((p, pi) => {
              const from = pi === 0 ? 0 : PERIODS[pi - 1].until;
              const group = slots.filter((s) => {
                const m = localMinuteOfDay(s.startAt, offset);
                return m >= from && m < p.until;
              });
              if (group.length === 0) return null;
              return (
                <div key={p.id}>
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-celestial-800/55">
                    <span aria-hidden="true" className="text-gold-600">
                      {p.glyph + VS}
                    </span>
                    {p.label}
                  </p>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-3">
                    {group.map((s) => {
                      const ok = bookable(s, now);
                      const picked = s.startAt === slot;
                      return (
                        <button
                          key={s.startAt}
                          type="button"
                          disabled={!ok}
                          aria-pressed={picked}
                          title={s.startAt <= now ? "This time has passed" : SLOT_HINT[s.status]}
                          onClick={() => onSlot(s.startAt)}
                          className={`min-h-11 rounded-full px-2 text-xs font-medium transition duration-200 ${
                            picked
                              ? "bg-gradient-to-r from-celestial-600 to-celestial-800 text-white shadow-[0_8px_18px_-10px_rgba(82,51,150,0.9)]"
                              : ok
                                ? "bg-white text-celestial-800 ring-1 ring-lavender-200 hover:ring-celestial-400 active:scale-95"
                                : s.status === "yours"
                                  ? "cursor-not-allowed bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                                  : s.status === "userBusy"
                                    ? "cursor-not-allowed bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                                    : "cursor-not-allowed bg-lavender-50/60 text-celestial-800/30 line-through"
                          }`}
                        >
                          {formatTime(s.startAt, offset)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* The chosen moment, on a celestial arc. */}
      <div className="md:col-span-2">
        <div className="relative overflow-hidden rounded-t-[80px] rounded-b-[32px] bg-gradient-to-br from-celestial-800 to-celestial-600 px-6 pb-5 pt-6 text-center text-white">
          <svg viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-x-0 top-2 h-10 w-full text-gold-300/50">
            <path d="M 20 58 Q 200 -10 380 58" fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 5" vectorEffect="non-scaling-stroke" />
          </svg>
          <span aria-hidden="true" className="absolute left-8 top-5 text-[10px] text-gold-300 motion-safe:animate-twinkle">✦</span>
          <span aria-hidden="true" className="absolute right-10 top-8 text-[8px] text-gold-300 motion-safe:animate-twinkle [animation-delay:1.6s]">✦</span>
          <p className="relative text-[11px] uppercase tracking-[0.22em] text-gold-300">Your moment</p>
          <p className="relative mt-1 font-display text-2xl font-semibold" aria-live="polite">
            {slot !== null ? (describe ? describe(slot) : formatSlot(slot, offset, schedule.timeZoneLabel)) : day?.slots[0] ? `${formatDay(day.slots[0].startAt, offset)} · pick a time` : "Pick a date and time"}
          </p>
        </div>
      </div>
    </div>
  );
}


/* ───────────────────────────── hooks ───────────────────────────── */

/**
 * An astrologer's live slot calendar plus the user's date/time pick. Kept
 * fresh every REFRESH_MS and when the tab regains focus; a pick that stops
 * being bookable is dropped. A calendar fetched for a previous astrologer
 * is never returned.
 */
export function useSlotCalendar(
  /** An astrologer id, or "pool:<minutes>" for a duration card's pooled calendar; null holds off fetching. */
  astrologerId: string | null,
  userId: () => string,
) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const latest = useRef(astrologerId);
  const who = useRef(userId);
  useEffect(() => {
    latest.current = astrologerId;
    who.current = userId;
  });

  const reload = useCallback(async (): Promise<Schedule | null> => {
    if (!astrologerId) return null;
    try {
      const pool = /^pool:(\d+)$/.exec(astrologerId);
      const params = new URLSearchParams(pool ? { minutes: pool[1] } : { astrologerId });
      params.set("userId", who.current());
      const next = await api<Schedule>(`/api/bookings/slots?${params}`, { cache: "no-store" });
      if (latest.current !== astrologerId) return null; // superseded by another pick
      const t = Date.now();
      setNow(t);
      setSchedule(next);
      setLoadError(null);
      // Drop a pick that's no longer bookable; open on the first day with a free slot.
      const free = (s: Slot) => bookable(s, t);
      setSlot((s) => (s !== null && next.days.some((d) => d.slots.some((x) => x.startAt === s && free(x))) ? s : null));
      setDate((d) => (d && next.days.some((x) => x.date === d && x.slots.some(free)) ? d : (next.days.find((x) => x.slots.some(free))?.date ?? null)));
      return next;
    } catch (err) {
      if (latest.current === astrologerId) setLoadError((err as Error).message);
      return null;
    }
  }, [astrologerId]);

  useEffect(() => {
    // Initial fetch (and again for a newly chosen astrologer), then keep the calendar in sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    const t = setInterval(() => void reload(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const live = schedule?.astrologerId === astrologerId ? schedule : null;
  return { schedule: live, loadError: live ? null : loadError, setLoadError, date, setDate, slot, setSlot, now, reload };
}

/** Locks page scroll, focuses the panel, traps Tab inside it, closes on Escape and restores focus on unmount. */
export function useModal(panelRef: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [panelRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelRef, close]);
}
