"use client";

import { useMemo, useState } from "react";
import { loginAstrologer } from "@/app/astrologer/actions";
import { buttonClass } from "./client";

export interface LoginOption {
  id: string;
  name: string;
  provider: string;
  avatarUrl?: string;
  expertise: string;
  /** Requests waiting for this astrologer's response; shown as a green dot. */
  newRequests: number;
}

const requestsLabel = (n: number) => `${n} new request${n > 1 ? "s" : ""}`;

/** Green "new requests" dot for an avatar's corner. */
function NewDot({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span role="status" aria-label={requestsLabel(count)} title={requestsLabel(count)} className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center">
      <span aria-hidden="true" className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" />
      <span aria-hidden="true" className="relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-white bg-emerald-500" />
    </span>
  );
}

/** Searchable list of astrologer profiles to sign in as (no authentication yet). */
export default function LoginPicker({ options, current }: { options: LoginOption[]; current: LoginOption | null }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (needle ? options.filter((o) => `${o.name} ${o.provider} ${o.expertise}`.toLowerCase().includes(needle)) : options).slice(0, 60);
  }, [options, q]);

  return (
    <div className="flex flex-col gap-5">
      {current && (
        <form action={loginAstrologer} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gold-300/60 bg-gold-100/60 p-4">
          <input type="hidden" name="astrologerId" value={current.id} />
          <p className="flex flex-wrap items-center gap-2 text-sm text-celestial-800">
            Signed in as <span className="font-semibold text-celestial-900">{current.name}</span>
            {current.newRequests > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-500" />
                {requestsLabel(current.newRequests)}
              </span>
            )}
          </p>
          <button type="submit" className={buttonClass("primary")}>
            Continue to dashboard →
          </button>
        </form>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-celestial-900">Find your profile</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, provider or expertise"
          className="w-full rounded-full border border-celestial-900/15 bg-white/90 px-5 py-3 text-sm text-celestial-900 shadow-sm focus:border-celestial-500 focus:outline-none"
        />
      </label>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((o) => (
          <li key={o.id}>
            <form action={loginAstrologer}>
              <input type="hidden" name="astrologerId" value={o.id} />
              <button
                type="submit"
                className="group flex w-full items-center gap-3 rounded-2xl border border-white/70 bg-white/80 p-3 text-left shadow-[0_10px_30px_-20px_rgba(61,37,114,0.45)] ring-1 ring-celestial-900/5 backdrop-blur-md transition duration-300 hover:-translate-y-0.5 hover:ring-gold-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celestial-600"
              >
                <span className="relative shrink-0 rounded-full bg-gradient-to-br from-gold-300 via-lavender-200 to-celestial-400 p-[2px]">
                  {o.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- provider-hosted avatars on arbitrary domains
                    <img src={o.avatarUrl} alt="" className="h-11 w-11 rounded-full border-2 border-white object-cover" />
                  ) : (
                    <span className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-white bg-lavender-100 font-display text-xl font-semibold text-celestial-700">
                      {o.name.charAt(0)}
                    </span>
                  )}
                  <NewDot count={o.newRequests} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-lg font-semibold leading-tight text-celestial-900">{o.name}</span>
                  <span className="block truncate text-xs text-celestial-800/60">
                    {o.provider}
                    {o.expertise && ` · ${o.expertise}`}
                  </span>
                  {o.newRequests > 0 && <span className="mt-0.5 block text-xs font-medium text-emerald-700">{requestsLabel(o.newRequests)}</span>}
                </span>
                <span aria-hidden="true" className="text-celestial-600 transition-transform duration-300 group-hover:translate-x-1">
                  →
                </span>
              </button>
            </form>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="text-center text-sm text-celestial-800/60">No astrologer matches “{q}”.</p>}
    </div>
  );
}
