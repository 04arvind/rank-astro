"use client";

import { useActionState, useState } from "react";
import { saveWeeklyHoursAction, setStatusAction } from "@/app/astrologer/actions";
import { bookingConfig } from "@/config/booking.config";
import { minutesToInput, WEEKDAY_LABELS } from "@/lib/astrologer-portal/calendar";
import type { DayHours, PortalStatus } from "@/lib/astrologer-portal/types";
import { buttonClass, Feedback } from "./client";

/** Monday first, like the calendar. */
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Available / unavailable switch. */
export function StatusToggle({ status }: { status: PortalStatus }) {
  const [result, run, pending] = useActionState(setStatusAction, null);
  const on = status === "available";
  return (
    <form action={run} className="flex flex-col gap-2">
      <input type="hidden" name="status" value={on ? "unavailable" : "available"} />
      <div className="flex items-center gap-4">
        <button
          type="submit"
          role="switch"
          aria-checked={on}
          aria-label="Available for consultations"
          disabled={pending}
          className={`relative h-8 w-14 shrink-0 rounded-full transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celestial-600 disabled:opacity-60 ${on ? "bg-emerald-500" : "bg-zinc-300"}`}
        >
          <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all duration-300 ${on ? "left-7" : "left-1"}`} />
        </button>
        <div>
          <p className="font-medium text-celestial-900">{on ? "Available" : "Unavailable"}</p>
          <p className="text-xs text-celestial-800/60">{on ? "You're taking consultations in your working hours." : "You're not taking new consultations."}</p>
        </div>
      </div>
      <Feedback result={result} />
    </form>
  );
}

/** Weekly working hours, one row per weekday. */
export function WeeklyHoursForm({ weeklyHours }: { weeklyHours: DayHours[] }) {
  const [result, run, pending] = useActionState(saveWeeklyHoursAction, null);
  const [enabled, setEnabled] = useState(() => weeklyHours.map((d) => d.enabled));
  const input =
    "w-full rounded-lg border border-celestial-900/15 bg-white px-2 py-1.5 text-sm text-celestial-900 focus:border-celestial-500 focus:outline-none disabled:bg-zinc-50 disabled:text-zinc-400";

  return (
    <form action={run} className="flex flex-col gap-3">
      <ul className="divide-y divide-celestial-900/5">
        {ORDER.map((d) => {
          const h = weeklyHours[d] ?? { enabled: true, ...bookingConfig.workingHours };
          return (
            <li key={d} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)]">
              <label className="flex items-center gap-2 text-sm font-medium text-celestial-900">
                <input
                  type="checkbox"
                  name={`day${d}_enabled`}
                  checked={enabled[d]}
                  onChange={(e) => setEnabled((xs) => xs.map((x, i) => (i === d ? e.target.checked : x)))}
                  className="h-4 w-4 accent-celestial-700"
                />
                {WEEKDAY_LABELS[d]}
              </label>
              <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
                <input type="time" name={`day${d}_start`} step={bookingConfig.slotMinutes * 60} defaultValue={minutesToInput(h.startMinute)} disabled={!enabled[d]} className={input} aria-label={`${WEEKDAY_LABELS[d]} start`} />
                <span className="text-celestial-800/50">–</span>
                <input type="time" name={`day${d}_end`} step={bookingConfig.slotMinutes * 60} defaultValue={minutesToInput(h.endMinute)} disabled={!enabled[d]} className={input} aria-label={`${WEEKDAY_LABELS[d]} end`} />
                {!enabled[d] && <span className="shrink-0 text-xs text-celestial-800/50">Day off</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass("primary")}>
          {pending ? "Saving…" : "Save working hours"}
        </button>
        <Feedback result={result} />
      </div>
    </form>
  );
}
