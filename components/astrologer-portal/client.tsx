"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import type { ActionResult } from "@/app/astrologer/actions";

/* Small interactive pieces for the astrologer portal. */

type Action = (prev: ActionResult, formData: FormData) => Promise<ActionResult>;

const BUTTON = {
  primary: "bg-celestial-700 text-white hover:bg-celestial-800 focus-visible:outline-celestial-600",
  gold: "bg-gold-300 text-celestial-900 hover:bg-gold-400 focus-visible:outline-gold-400",
  ghost: "border border-celestial-900/15 bg-white/70 text-celestial-800 hover:border-celestial-600/40 hover:bg-white focus-visible:outline-celestial-600",
  danger: "border border-rose-200 bg-white/70 text-rose-700 hover:bg-rose-50 focus-visible:outline-rose-400",
} as const;

export const buttonClass = (variant: keyof typeof BUTTON = "primary") =>
  `inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON[variant]}`;

export function Feedback({ result }: { result: ActionResult }) {
  if (!result?.message) return null;
  return (
    <p role="status" className={`text-xs ${result.ok ? "text-emerald-700" : "text-rose-700"}`}>
      {result.message}
    </p>
  );
}

/** One-button form for a server action, with pending state and its result. */
export function ActionButton({
  action,
  fields = {},
  children,
  variant = "primary",
  pendingLabel,
  showResult = true,
}: {
  action: Action;
  fields?: Record<string, string>;
  children: ReactNode;
  variant?: keyof typeof BUTTON;
  pendingLabel?: string;
  showResult?: boolean;
}) {
  const [result, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="inline-flex flex-col items-start gap-1">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" disabled={pending} className={buttonClass(variant)}>
        {pending ? (pendingLabel ?? "Working…") : children}
      </button>
      {showResult && !result?.ok && <Feedback result={result} />}
    </form>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${pad(m)}:${pad(s % 60)}`;
}

/** Live "starts in" / "call within" countdown to `to`. */
export function Countdown({ to, prefix = "in", overdue = "Now" }: { to: number; prefix?: string; overdue?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  if (now === null) return <span className="tabular-nums">…</span>;
  const left = to - now;
  return <span className="tabular-nums">{left > 0 ? `${prefix} ${span(left)}` : overdue}</span>;
}

/** Re-renders the server page every `seconds`, so new requests and status changes show up. */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
