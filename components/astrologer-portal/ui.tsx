import type { ReactNode } from "react";
import { bookingConfig } from "@/config/booking.config";
import type { ConsultationStatus } from "@/lib/astrologer-portal/types";
import { formatDay, formatTime } from "@/lib/booking/time";

/*
 * Presentational building blocks for the astrologer portal, in the
 * celestial theme (ivory surfaces, celestial ink, gold accents).
 */

export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const off = bookingConfig.utcOffsetMinutes;
export const time = (t: number) => formatTime(t, off);
export const day = (t: number) => formatDay(t, off);
export const when = (t: number) => `${formatDay(t, off)} · ${formatTime(t, off)}`;

export function Panel({ title, action, children, className = "" }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section
      className={`relative overflow-hidden rounded-2xl border border-white/70 bg-white/80 p-5 shadow-[0_10px_30px_-18px_rgba(61,37,114,0.45)] ring-1 ring-celestial-900/5 backdrop-blur-md sm:p-6 ${className}`}
    >
      <span aria-hidden="true" className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-gold-300 to-transparent opacity-70" />
      {(title || action) && (
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="font-display text-2xl font-semibold text-celestial-900">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatCard({ label, value, hint, glyph }: { label: string; value: ReactNode; hint?: ReactNode; glyph: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-white/70 bg-white/80 p-4 shadow-[0_10px_30px_-20px_rgba(61,37,114,0.45)] ring-1 ring-celestial-900/5 backdrop-blur-md">
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-lavender-100 text-lg text-celestial-700 ring-1 ring-gold-300/60">
        {glyph}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-[0.15em] text-celestial-800/60">{label}</p>
        <p className="mt-0.5 font-display text-3xl font-semibold leading-tight text-celestial-900">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-celestial-800/60">{hint}</p>}
      </div>
    </div>
  );
}

const STATUS: Record<ConsultationStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-gold-100 text-gold-600 ring-gold-300/70" },
  confirmed: { label: "Scheduled", className: "bg-lavender-100 text-celestial-700 ring-lavender-300" },
  due: { label: "Starting", className: "bg-celestial-600 text-white ring-celestial-700" },
  live: { label: "On call", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  completed: { label: "Completed", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  cancelled: { label: "Cancelled", className: "bg-zinc-100 text-zinc-600 ring-zinc-200" },
  rejected: { label: "Rejected", className: "bg-rose-50 text-rose-700 ring-rose-200" },
  no_show: { label: "No-show", className: "bg-rose-50 text-rose-700 ring-rose-200" },
};

/** An accepted talk-now call is "Accepted" until placed; an accepted slot is "Scheduled". */
export function StatusBadge({ status, kind }: { status: ConsultationStatus; kind?: "instant" | "scheduled" }) {
  const s = STATUS[status];
  const label = status === "confirmed" && kind === "instant" ? "Accepted" : s.label;
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${s.className}`}>{label}</span>;
}

export function KindBadge({ kind }: { kind: "instant" | "scheduled" }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-celestial-900/10 px-2 py-0.5 text-[11px] font-medium text-celestial-800/70">
      {kind === "instant" ? "⚡ Talk now" : "◷ Scheduled"}
    </span>
  );
}

export function Avatar({ name, src, size = "md" }: { name: string; src?: string; size?: "md" | "lg" }) {
  const dim = size === "lg" ? "h-24 w-24 text-4xl" : "h-11 w-11 text-xl";
  return (
    <div className="shrink-0 rounded-full bg-gradient-to-br from-gold-300 via-lavender-200 to-celestial-400 p-[2px]">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- provider-hosted avatars on arbitrary domains
        <img src={src} alt={name} className={`${dim} rounded-full border-2 border-white object-cover`} />
      ) : (
        <div className={`${dim} flex items-center justify-center rounded-full border-2 border-white bg-lavender-100 font-display font-semibold text-celestial-700`}>
          {name.trim().charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );
}

export function Empty({ glyph = "☾", children }: { glyph?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-celestial-900/15 bg-ivory-50/60 px-4 py-10 text-center text-sm text-celestial-800/60">
      <span aria-hidden="true" className="text-2xl text-gold-400">
        {glyph}
      </span>
      {children}
    </div>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-gold-300/60 bg-gold-100/60 px-2.5 py-0.5 text-xs font-medium text-celestial-800">{children}</span>;
}
