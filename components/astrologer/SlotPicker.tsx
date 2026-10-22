"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDay, formatSlot, formatTime } from "@/lib/booking/time";
import type { Schedule, Slot } from "@/types/booking";

/*
 * Day tabs + slot grid for booking a call. The calendar is refetched every
 * REFRESH_MS, when the tab regains focus, and after a failed booking, so
 * slots taken by someone else drop out; the server still rejects a stale
 * pick with 409 SLOT_UNAVAILABLE.
 */

const REFRESH_MS = 30_000;

export interface BookedCall {
  bookingId: string;
  startAt: number;
  endAt: number;
  label: string;
  astrologerNotified: boolean;
}

interface SlotPickerProps {
  astrologerId: string;
  userId: string;
  sessionId: string;
  onBooked: (call: BookedCall) => void;
  onBack: () => void;
}

type ApiError = { code?: string; message?: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => null)) as { data?: T; error?: ApiError } | null;
  if (!res.ok || !body?.data) {
    throw Object.assign(new Error(body?.error?.message ?? "Something went wrong. Please try again."), { code: body?.error?.code });
  }
  return body.data;
}

const SLOT_STYLE: Record<Slot["status"], string> = {
  available: "border-zinc-300 text-zinc-800 hover:border-indigo-400 hover:bg-indigo-50",
  unavailable: "border-zinc-100 bg-zinc-50 text-zinc-300 line-through",
  userBusy: "border-amber-200 bg-amber-50 text-amber-700",
  yours: "border-green-300 bg-green-50 text-green-700",
};

const SLOT_HINT: Record<Slot["status"], string> = {
  available: "Available",
  unavailable: "Unavailable",
  userBusy: "You have another call booked then",
  yours: "Already booked by you",
};

export default function SlotPicker({ astrologerId, userId, sessionId, onBooked, onBack }: SlotPickerProps) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [dayIndex, setDayIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ astrologerId, userId });
      const next = await api<Schedule>(`/api/bookings/slots?${params}`, { cache: "no-store" });
      setSchedule(next);
      // Drop a selection that's no longer bookable.
      setSelected((s) => (s !== null && next.days.some((d) => d.slots.some((x) => x.startAt === s && x.status === "available")) ? s : null));
      // Open on the first day with a free slot.
      setDayIndex((i) => i ?? Math.max(0, next.days.findIndex((d) => d.slots.some((x) => x.status === "available"))));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [astrologerId, userId]);

  useEffect(() => {
    // Initial fetch, then keep the calendar in sync while the picker is open.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const confirm = async () => {
    if (selected === null || !schedule) return;
    setBooking(true);
    setError(null);
    try {
      const b = await api<Omit<BookedCall, "label">>("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ astrologerId, userId, sessionId, startAt: selected }),
      });
      onBooked({ ...b, label: formatSlot(b.startAt, schedule.utcOffsetMinutes, schedule.timeZoneLabel) });
    } catch (err) {
      setError((err as Error).message);
      if ((err as { code?: string }).code === "SLOT_UNAVAILABLE") {
        setSelected(null);
        void load();
      }
    } finally {
      setBooking(false);
    }
  };

  if (!schedule || dayIndex === null) {
    return (
      <div className="mt-4">
        {error ? (
          <p className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>
        ) : (
          <p className="text-sm text-zinc-500" aria-live="polite">
            Loading available slots…
          </p>
        )}
        <button type="button" onClick={onBack} className="mt-5 w-full rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50">
          Back
        </button>
      </div>
    );
  }

  const offset = schedule.utcOffsetMinutes;
  const day = schedule.days[dayIndex];
  const freeCount = (i: number) => schedule.days[i].slots.filter((s) => s.status === "available").length;

  return (
    <div className="mt-3 text-left">
      <p className="text-center text-xs text-zinc-500">
        {schedule.slotMinutes}-min slots · times in {schedule.timeZoneLabel}
      </p>

      <div role="tablist" aria-label="Day" className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {schedule.days.map((d, i) => {
          const start = d.slots[0]?.startAt ?? 0;
          const [weekday, date] = formatDay(start, offset).split(", ");
          const free = freeCount(i);
          return (
            <button
              key={d.date}
              type="button"
              role="tab"
              aria-selected={i === dayIndex}
              onClick={() => setDayIndex(i)}
              className={`flex min-w-14 shrink-0 flex-col items-center rounded-lg border px-2 py-1.5 text-xs ${
                i === dayIndex ? "border-indigo-600 bg-indigo-600 text-white" : "border-zinc-200 text-zinc-700 hover:bg-zinc-50"
              } ${free === 0 && i !== dayIndex ? "opacity-50" : ""}`}
            >
              <span className="font-medium">{i === 0 ? "Today" : i === 1 ? "Tmrw" : weekday}</span>
              <span>{date}</span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" className="mt-3 max-h-56 overflow-y-auto">
        {day.slots.every((s) => s.status === "unavailable") ? (
          <p className="py-6 text-center text-sm text-zinc-500">No slots left on this day.</p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {day.slots.map((s) => {
              const isSelected = s.startAt === selected;
              return (
                <button
                  key={s.startAt}
                  type="button"
                  disabled={s.status !== "available"}
                  aria-pressed={isSelected}
                  title={SLOT_HINT[s.status]}
                  onClick={() => setSelected(s.startAt)}
                  className={`rounded-md border px-1 py-1.5 text-xs disabled:cursor-not-allowed ${
                    isSelected ? "border-indigo-600 bg-indigo-600 text-white" : SLOT_STYLE[s.status]
                  }`}
                >
                  {formatTime(s.startAt, offset)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-green-400" /> Yours
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-amber-400" /> You&apos;re busy
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-zinc-300" /> Unavailable
        </span>
      </div>

      {error && <p className="mt-3 rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onBack} className="flex-1 rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50">
          Back
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={selected === null || booking}
          className="flex-1 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          {booking ? "Booking…" : selected === null ? "Pick a slot" : `Book ${formatTime(selected, offset)}`}
        </button>
      </div>
    </div>
  );
}
