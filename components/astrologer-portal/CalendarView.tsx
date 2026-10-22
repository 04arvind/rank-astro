"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import { addBlockAction, removeBlockAction, setDayAction, toggleSlotAction, type ActionResult } from "@/app/astrologer/actions";
import { bookingConfig } from "@/config/booking.config";
import {
  addDays,
  daySlots,
  hoursOn,
  minutesToInput,
  monthGrid,
  weekStart,
  WEEKDAY_LABELS,
  type DaySlot,
} from "@/lib/astrologer-portal/calendar";
import type { CalendarEvent, PortalSettings } from "@/lib/astrologer-portal/types";
import { formatTime, localDate } from "@/lib/booking/time";
import { buttonClass, Feedback } from "./client";

/*
 * Availability calendar: day, week and month views over the astrologer's
 * hours, blocks and booked consultations. Clicking an open slot blocks it,
 * clicking a blocked slot opens it again; the day panel sets a day off,
 * custom hours, or blocks a time range.
 */

type View = "day" | "week" | "month";
type Settings = Pick<PortalSettings, "weeklyHours" | "dayOverrides" | "blocks">;

const OFF = bookingConfig.utcOffsetMinutes;
const SLOT = bookingConfig.slotMinutes;
const { startMinute: GRID_START, endMinute: GRID_END } = bookingConfig.workingHours;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const t = (ms: number) => formatTime(ms, OFF);
const label = (date: string, opts: { weekday?: boolean; year?: boolean } = {}) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${opts.weekday ? `${WEEKDAY_LABELS[d.getUTCDay()].slice(0, 3)}, ` : ""}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}${opts.year ? ` ${d.getUTCFullYear()}` : ""}`;
};

const SLOT_STYLE: Record<DaySlot["state"], string> = {
  open: "border-emerald-200 bg-emerald-50/70 text-emerald-800 hover:border-emerald-400 hover:bg-emerald-100 cursor-pointer",
  booked: "border-celestial-600/30 bg-celestial-600 text-white",
  blocked: "border-rose-200 bg-[repeating-linear-gradient(135deg,#fff1f2_0_6px,#ffe4e6_6px_12px)] text-rose-700 hover:border-rose-400 cursor-pointer",
  off: "border-transparent bg-zinc-100/70 text-zinc-400",
  past: "border-transparent bg-zinc-50 text-zinc-300",
};

const LEGEND: [DaySlot["state"], string][] = [
  ["open", "Available"],
  ["booked", "Booked"],
  ["blocked", "Blocked"],
  ["off", "Off hours"],
];

export default function CalendarView({ settings, events, now }: { settings: Settings; events: CalendarEvent[]; now: number }) {
  const today = localDate(now, OFF);
  const [view, setView] = useState<View>("week");
  const [date, setDate] = useState(today);
  const [pending, startTransition] = useTransition();
  const [busySlot, setBusySlot] = useState<number | null>(null);
  const [result, setResult] = useState<ActionResult>(null);

  const days = useMemo(
    () => (view === "day" ? [date] : view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(date), i)) : monthGrid(date)),
    [view, date],
  );

  // One row grid for the week: the standard day stretched to cover any custom hours.
  const grid = useMemo(() => {
    let start = GRID_START;
    let end = GRID_END;
    for (const d of days) {
      const h = hoursOn(settings, d);
      if (h) {
        start = Math.min(start, h.startMinute);
        end = Math.max(end, h.endMinute);
      }
    }
    return { start, end };
  }, [days, settings]);

  const slotsOf = (d: string) => daySlots(d, settings, events, { offsetMinutes: OFF, slotMinutes: SLOT, gridStart: grid.start, gridEnd: grid.end, now });

  const toggle = (s: DaySlot) => {
    if (pending || (s.state !== "open" && s.state !== "blocked")) return;
    const fd = new FormData();
    fd.set("startAt", String(s.startAt));
    fd.set("endAt", String(s.endAt));
    setBusySlot(s.startAt);
    startTransition(async () => {
      setResult(await toggleSlotAction(null, fd));
      setBusySlot(null);
    });
  };

  const step = (n: number) => {
    if (view === "day") setDate(addDays(date, n));
    else if (view === "week") setDate(addDays(date, 7 * n));
    else {
      const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + n);
      setDate(d.toISOString().slice(0, 10));
    }
  };

  const title =
    view === "day"
      ? label(date, { weekday: true, year: true })
      : view === "week"
        ? `${label(days[0])} – ${label(days[6], { year: true })}`
        : `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

  const openDay = (d: string) => {
    setDate(d);
    setView("day");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => step(-1)} aria-label="Previous" className={buttonClass("ghost")}>
            ‹
          </button>
          <button type="button" onClick={() => setDate(today)} className={buttonClass("ghost")}>
            Today
          </button>
          <button type="button" onClick={() => step(1)} aria-label="Next" className={buttonClass("ghost")}>
            ›
          </button>
          <h3 className="ml-1 font-display text-xl font-semibold text-celestial-900">{title}</h3>
        </div>
        <div role="tablist" aria-label="Calendar view" className="flex rounded-full border border-celestial-900/10 bg-white/70 p-1">
          {(["day", "week", "month"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium capitalize transition ${view === v ? "bg-celestial-700 text-white shadow" : "text-celestial-800/70 hover:text-celestial-900"}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-celestial-800/70">
        {LEGEND.map(([s, l]) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded border ${SLOT_STYLE[s]}`} /> {l}
          </span>
        ))}
        {view !== "month" && <span className="text-celestial-800/50">· Click an available slot to block it, a blocked one to open it.</span>}
        {pending && <span className="text-celestial-600">Saving…</span>}
        {!pending && <Feedback result={result} />}
      </div>

      {view === "month" && <MonthGrid days={days} month={date.slice(0, 7)} today={today} settings={settings} events={events} onPick={openDay} />}

      {view === "week" && (
        <div className="overflow-x-auto rounded-xl border border-celestial-900/10 bg-white/60">
          <div className="grid min-w-[760px] grid-cols-[64px_repeat(7,minmax(0,1fr))]">
            <div />
            {days.map((d) => {
              const h = hoursOn(settings, d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => openDay(d)}
                  className={`border-b border-l border-celestial-900/10 px-2 py-2 text-left transition hover:bg-lavender-50 ${d === today ? "bg-gold-100/60" : ""}`}
                >
                  <span className="block text-xs font-semibold text-celestial-900">{label(d, { weekday: true })}</span>
                  <span className="block text-[11px] text-celestial-800/60">{h ? `${minutesToInput(h.startMinute)}–${minutesToInput(h.endMinute)}` : "Day off"}</span>
                </button>
              );
            })}
            {slotsOf(days[0]).map((row, i) => (
              <WeekRow key={row.startAt} index={i} rowStart={row.startAt} columns={days.map((d) => slotsOf(d)[i])} busy={busySlot} onToggle={toggle} />
            ))}
          </div>
        </div>
      )}

      {view === "day" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {slotsOf(date).map((s) => (
              <li key={s.startAt}>
                <button
                  type="button"
                  onClick={() => toggle(s)}
                  disabled={s.state !== "open" && s.state !== "blocked"}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${SLOT_STYLE[s.state]} ${busySlot === s.startAt ? "animate-pulse" : ""}`}
                >
                  <span className="font-medium tabular-nums">
                    {t(s.startAt)} – {t(s.endAt)}
                  </span>
                  <span className="truncate text-xs">
                    {s.state === "booked" ? s.event?.userName : s.state === "blocked" ? (s.block?.note ?? "Blocked") : s.state === "open" ? "Available" : s.state === "past" ? "Past" : "Off"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <DayPanel key={date} date={date} settings={settings} />
        </div>
      )}
    </div>
  );
}

function WeekRow({ index, rowStart, columns, busy, onToggle }: { index: number; rowStart: number; columns: DaySlot[]; busy: number | null; onToggle: (s: DaySlot) => void }) {
  return (
    <>
      <div className="border-t border-celestial-900/5 pr-2 pt-1 text-right text-[11px] tabular-nums text-celestial-800/50">{index % 2 === 0 ? t(rowStart) : ""}</div>
      {columns.map((s) => (
        <div key={s.startAt} className="border-l border-t border-celestial-900/5 p-0.5">
          <button
            type="button"
            onClick={() => onToggle(s)}
            disabled={s.state !== "open" && s.state !== "blocked"}
            title={`${t(s.startAt)} – ${t(s.endAt)}${s.event ? ` · ${s.event.userName}` : ""}`}
            className={`block h-7 w-full truncate rounded border px-1 text-left text-[10px] leading-7 transition ${SLOT_STYLE[s.state]} ${busy === s.startAt ? "animate-pulse" : ""}`}
          >
            {s.state === "booked" ? s.event?.userName : s.state === "blocked" ? "Blocked" : ""}
          </button>
        </div>
      ))}
    </>
  );
}

function MonthGrid({
  days,
  month,
  today,
  settings,
  events,
  onPick,
}: {
  days: string[];
  month: string;
  today: string;
  settings: Settings;
  events: CalendarEvent[];
  onPick: (d: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-celestial-900/10 bg-white/60">
      <div className="grid grid-cols-7 border-b border-celestial-900/10 bg-lavender-50/70 text-center text-[11px] font-semibold uppercase tracking-wider text-celestial-800/60">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const h = hoursOn(settings, d);
          const booked = events.filter((e) => localDate(e.startAt, OFF) === d).length;
          const blocked = settings.blocks.some((b) => localDate(b.startAt, OFF) === d);
          const inMonth = d.startsWith(month);
          return (
            <button
              key={d}
              type="button"
              onClick={() => onPick(d)}
              className={`flex min-h-20 flex-col items-start gap-1 border-b border-r border-celestial-900/5 p-1.5 text-left transition hover:bg-lavender-50 sm:min-h-24 sm:p-2 ${inMonth ? "" : "opacity-40"} ${h ? "" : "bg-zinc-50"}`}
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${d === today ? "bg-celestial-700 text-white" : "text-celestial-900"}`}
              >
                {Number(d.slice(8))}
              </span>
              <span className="hidden text-[11px] text-celestial-800/60 sm:block">{h ? `${minutesToInput(h.startMinute)}–${minutesToInput(h.endMinute)}` : "Off"}</span>
              <span className="flex flex-wrap gap-1">
                {booked > 0 && <span className="rounded-full bg-celestial-600 px-1.5 text-[10px] font-medium text-white">{booked} call{booked > 1 ? "s" : ""}</span>}
                {blocked && <span className="rounded-full bg-rose-100 px-1.5 text-[10px] font-medium text-rose-700">Blocked</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Set the day's hours (weekly default, off, custom) and block a time range. */
function DayPanel({ date, settings }: { date: string; settings: Settings }) {
  const override = settings.dayOverrides[date];
  const hours = hoursOn(settings, date) ?? bookingConfig.workingHours;
  const [mode, setMode] = useState<"default" | "off" | "custom">(override ? (override.off ? "off" : "custom") : "default");
  const [dayResult, saveDay, savingDay] = useActionState(setDayAction, null);
  const [blockResult, addBlock, addingBlock] = useActionState(addBlockAction, null);
  const [, removeBlock] = useActionState(removeBlockAction, null);
  const dayBlocks = settings.blocks.filter((b) => localDate(b.startAt, OFF) === date);
  const weekly = settings.weeklyHours[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const input = "w-full rounded-lg border border-celestial-900/15 bg-white px-2 py-1.5 text-sm text-celestial-900 focus:border-celestial-500 focus:outline-none";

  return (
    <aside className="flex flex-col gap-4 rounded-xl border border-celestial-900/10 bg-ivory-50/80 p-4">
      <form action={saveDay} className="flex flex-col gap-3">
        <input type="hidden" name="date" value={date} />
        <h4 className="font-display text-lg font-semibold text-celestial-900">This day</h4>
        {(
          [
            ["default", `Weekly hours (${weekly?.enabled ? `${minutesToInput(weekly.startMinute)}–${minutesToInput(weekly.endMinute)}` : "off"})`],
            ["custom", "Custom hours"],
            ["off", "Block the whole day"],
          ] as const
        ).map(([v, l]) => (
          <label key={v} className="flex items-center gap-2 text-sm text-celestial-800">
            <input type="radio" name="mode" value={v} checked={mode === v} onChange={() => setMode(v)} className="accent-celestial-700" />
            {l}
          </label>
        ))}
        {mode === "custom" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-celestial-800/70">
              From
              <input type="time" name="start" step={SLOT * 60} defaultValue={minutesToInput(hours.startMinute)} className={input} />
            </label>
            <label className="text-xs text-celestial-800/70">
              To
              <input type="time" name="end" step={SLOT * 60} defaultValue={minutesToInput(hours.endMinute)} className={input} />
            </label>
          </div>
        )}
        <button type="submit" disabled={savingDay} className={buttonClass("primary")}>
          {savingDay ? "Saving…" : "Save day"}
        </button>
        <Feedback result={dayResult} />
      </form>

      <form action={addBlock} className="flex flex-col gap-3 border-t border-celestial-900/10 pt-4">
        <input type="hidden" name="date" value={date} />
        <h4 className="font-display text-lg font-semibold text-celestial-900">Block time</h4>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-celestial-800/70">
            From
            <input type="time" name="start" step={SLOT * 60} defaultValue="13:00" className={input} required />
          </label>
          <label className="text-xs text-celestial-800/70">
            To
            <input type="time" name="end" step={SLOT * 60} defaultValue="14:00" className={input} required />
          </label>
        </div>
        <input name="note" maxLength={80} placeholder="Reason (optional)" className={input} />
        <button type="submit" disabled={addingBlock} className={buttonClass("gold")}>
          {addingBlock ? "Blocking…" : "Block time"}
        </button>
        <Feedback result={blockResult} />
      </form>

      {dayBlocks.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-celestial-900/10 pt-4">
          {dayBlocks.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-2 text-sm text-celestial-800">
              <span>
                {t(b.startAt)} – {t(b.endAt)}
                {b.note && <span className="text-celestial-800/60"> · {b.note}</span>}
              </span>
              <form action={removeBlock}>
                <input type="hidden" name="blockId" value={b.id} />
                <button type="submit" className="text-xs font-medium text-rose-700 hover:underline">
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
