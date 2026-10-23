import Link from "next/link";
import { acceptAction, callNowAction, markReadAction, rejectAction } from "@/app/astrologer/actions";
import { config } from "@/config";
import { userLabel, type Consultation, type EarningsSummary, type PortalNotification, type PortalSettings } from "@/lib/astrologer-portal";
import { minutesToInput, todayKey } from "@/lib/astrologer-portal/calendar";
import type { AstrologerProfile } from "@/types/astrologer";
import { StatusToggle, WeeklyHoursForm } from "./AvailabilitySettings";
import { ActionButton, Countdown } from "./client";
import { Avatar, Chip, Empty, inr, KindBadge, Panel, StatCard, StatusBadge, time, when } from "./ui";

/* The astrologer dashboard's sections, one per tab. */

/** The user's mobile is never shown: calls go through the platform's Call now. */
function UserCell({ c }: { c: Consultation }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-lavender-100 font-display text-base font-semibold text-celestial-700">
        {userLabel(c.user).charAt(0)}
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium text-celestial-900">{userLabel(c.user)}</p>
        <p className="truncate text-xs text-celestial-800/50">{c.user.city ?? `ID ${c.user.id.slice(0, 14)}`}</p>
      </div>
    </div>
  );
}

function PaidBadge() {
  return <span className="ml-1.5 inline-flex rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">Paid</span>;
}

/** What the user asked about: topic and language, when they gave them. */
function Topic({ c }: { c: Consultation }) {
  if (!c.topic && !c.language) return <span className="text-celestial-800/40">—</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {c.topic && <span className="font-medium text-celestial-900">{c.topic}</span>}
      {c.language && <span className="text-xs text-celestial-800/60">{c.language}</span>}
    </div>
  );
}

function Actions({ c }: { c: Consultation }) {
  if (!c.canAccept && !c.canReject && !c.canCall) return null;
  // A pending talk-now call is accepted by calling the user.
  const accept = c.canAccept && !(c.kind === "instant" && c.canCall);
  return (
    <div className="flex flex-wrap gap-2">
      {accept && (
        <ActionButton action={acceptAction} fields={{ bookingId: c.bookingId }} variant="gold" pendingLabel="Accepting…">
          ✓ Accept
        </ActionButton>
      )}
      {c.canCall && (
        <ActionButton action={callNowAction} fields={{ bookingId: c.bookingId }} pendingLabel="Connecting…">
          ☏ {c.status === "pending" ? "Accept & call" : "Call now"}
        </ActionButton>
      )}
      {c.canReject && (
        <ActionButton action={rejectAction} fields={{ bookingId: c.bookingId }} variant="danger" pendingLabel="Declining…">
          ✕ Reject
        </ActionButton>
      )}
    </div>
  );
}

/** When the call is: talk-now shows its pickup deadline, scheduled its slot. */
function Timing({ c }: { c: Consultation }) {
  if (c.kind === "instant" && c.status === "pending" && c.pickupBy) {
    return (
      <span className="text-gold-600">
        Call by {time(c.pickupBy)} · <Countdown to={c.pickupBy} prefix="" overdue="overdue" /> left
      </span>
    );
  }
  if (c.status === "live") return <span className="text-emerald-700">On call · ends {time(c.endAt)}</span>;
  if (c.status === "pending" || c.status === "confirmed") {
    return (
      <span>
        {when(c.startAt)} · <Countdown to={c.startAt} prefix="starts in" />
      </span>
    );
  }
  return (
    <span>
      {when(c.startAt)}
      {c.note && <span className="block text-celestial-800/50">{c.note}</span>}
    </span>
  );
}

/** Bookings as a table on wide screens, cards on narrow ones. */
export function ConsultationTable({ items, empty, showActions = true }: { items: Consultation[]; empty: string; showActions?: boolean }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-celestial-800/50">
            <tr className="border-b border-celestial-900/10">
              <th className="py-2 pr-4 font-medium">User</th>
              <th className="py-2 pr-4 font-medium">Topic</th>
              <th className="py-2 pr-4 font-medium">Requested</th>
              <th className="py-2 pr-4 font-medium">Scheduled</th>
              <th className="py-2 pr-4 font-medium">Duration</th>
              <th className="py-2 pr-4 font-medium">Amount</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              {showActions && <th className="py-2 font-medium" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-celestial-900/5 text-celestial-800">
            {items.map((c) => (
              <tr key={c.bookingId} className="align-middle">
                <td className="py-3 pr-4">
                  <UserCell c={c} />
                </td>
                <td className="py-3 pr-4">
                  <Topic c={c} />
                </td>
                <td className="py-3 pr-4 whitespace-nowrap text-celestial-800/70">{when(c.requestedAt)}</td>
                <td className="py-3 pr-4">
                  <div className="flex flex-col gap-1">
                    <KindBadge kind={c.kind} />
                    <span className="text-xs">
                      <Timing c={c} />
                    </span>
                  </div>
                </td>
                <td className="py-3 pr-4 whitespace-nowrap">{c.durationMinutes} min</td>
                <td className="py-3 pr-4 whitespace-nowrap">
                  <span className="font-medium text-celestial-900">{inr(c.amount)}</span>
                  {c.paid && <PaidBadge />}
                </td>
                <td className="py-3 pr-4">
                  <StatusBadge status={c.status} kind={c.kind} />
                </td>
                {showActions && (
                  <td className="py-3">
                    <Actions c={c} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-3 md:hidden">
        {items.map((c) => (
          <li key={c.bookingId} className="flex flex-col gap-3 rounded-xl border border-celestial-900/10 bg-white/70 p-4">
            <div className="flex items-start justify-between gap-3">
              <UserCell c={c} />
              <StatusBadge status={c.status} kind={c.kind} />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <dt className="text-celestial-800/50">Topic</dt>
              <dd className="text-right">{[c.topic, c.language].filter(Boolean).join(" · ") || "—"}</dd>
              <dt className="text-celestial-800/50">Requested</dt>
              <dd className="text-right">{when(c.requestedAt)}</dd>
              <dt className="text-celestial-800/50">Scheduled</dt>
              <dd className="text-right">
                <Timing c={c} />
              </dd>
              <dt className="text-celestial-800/50">Duration</dt>
              <dd className="text-right">
                {c.durationMinutes} min · <KindBadge kind={c.kind} />
              </dd>
              <dt className="text-celestial-800/50">Amount</dt>
              <dd className="text-right font-semibold text-celestial-900">
                {inr(c.amount)} {c.paid && <PaidBadge />}
              </dd>
            </dl>
            {showActions && <Actions c={c} />}
          </li>
        ))}
      </ul>
    </>
  );
}

/* ───────────────────────────── Overview ───────────────────────────── */

export function Overview({
  today,
  upcoming,
  pending,
  earnings,
  unread,
}: {
  today: Consultation[];
  upcoming: Consultation[];
  pending: Consultation[];
  earnings: EarningsSummary;
  unread: number;
}) {
  const next = upcoming.slice(0, 4);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard glyph="☉" label="Today's calls" value={today.length} hint={`${today.filter((c) => c.status === "completed").length} completed`} />
        <StatCard glyph="◷" label="Upcoming" value={upcoming.length} hint="accepted calls" />
        <StatCard glyph="✦" label="Pending requests" value={pending.length} hint={pending.length ? "need your response" : "all caught up"} />
        <StatCard glyph="₹" label="Earnings" value={inr(earnings.total)} hint={`${inr(earnings.today)} today`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel
          title="Pending requests"
          action={
            <Link href="?tab=requests" className="text-sm font-medium text-celestial-600 hover:underline">
              All requests →
            </Link>
          }
        >
          {pending.length === 0 ? (
            <Empty glyph="✓">No requests waiting. New talk-now calls and bookings appear here.</Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {pending.map((c) => (
                <li key={c.bookingId} className="flex flex-col gap-3 rounded-xl border border-gold-300/60 bg-gold-100/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <UserCell c={c} />
                    <div className="flex flex-wrap items-center gap-2 text-xs text-celestial-800/70">
                      <KindBadge kind={c.kind} />
                      <span>
                        {c.durationMinutes} min · {inr(c.amount)}
                      </span>
                      <span>
                        · <Timing c={c} />
                      </span>
                    </div>
                  </div>
                  <Actions c={c} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Next up"
          action={
            <Link href="?tab=upcoming" className="text-sm font-medium text-celestial-600 hover:underline">
              Upcoming →
            </Link>
          }
        >
          {next.length === 0 ? (
            <Empty>No confirmed calls coming up.</Empty>
          ) : (
            <ol className="relative flex flex-col gap-4 border-l border-gold-300/70 pl-5">
              {next.map((c) => (
                <li key={c.bookingId} className="relative">
                  <span aria-hidden="true" className="absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-white bg-celestial-600 ring-1 ring-gold-300" />
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-celestial-900">{userLabel(c.user)}</p>
                      <p className="text-xs text-celestial-800/60">
                        {when(c.startAt)} · {c.durationMinutes} min
                      </p>
                    </div>
                    <StatusBadge status={c.status} kind={c.kind} />
                  </div>
                  <p className="mt-1 text-xs font-medium text-celestial-600">
                    <Countdown to={c.startAt} prefix="Starts in" overdue={c.status === "live" ? "In progress" : "Starting now"} />
                  </p>
                  {c.canCall && (
                    <div className="mt-2">
                      <Actions c={c} />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>

      <Panel title="Today's schedule">
        <ConsultationTable items={today} empty="Nothing scheduled for today." />
      </Panel>

      {unread > 0 && (
        <Link
          href="?tab=notifications"
          className="flex items-center justify-between rounded-2xl border border-celestial-600/20 bg-lavender-100/80 px-5 py-3 text-sm text-celestial-800 transition hover:bg-lavender-200/70"
        >
          <span>
            🔔 You have <strong>{unread}</strong> unread notification{unread > 1 ? "s" : ""}.
          </span>
          <span className="font-medium text-celestial-700">View →</span>
        </Link>
      )}
    </div>
  );
}

/* ───────────────────────────── Upcoming ───────────────────────────── */

export function UpcomingCalls({ items }: { items: Consultation[] }) {
  if (items.length === 0) return <Empty>No upcoming consultations. Keep your calendar open to receive bookings.</Empty>;
  const sorted = [...items].sort((x, y) => x.startAt - y.startAt);
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {sorted.map((c) => (
        <li key={c.bookingId} className="flex flex-col gap-4 rounded-2xl border border-white/70 bg-white/80 p-5 shadow-[0_10px_30px_-20px_rgba(61,37,114,0.45)] ring-1 ring-celestial-900/5">
          <div className="flex items-start justify-between gap-3">
            <UserCell c={c} />
            <StatusBadge status={c.status} kind={c.kind} />
          </div>
          <div className="rounded-xl bg-lavender-50 px-4 py-3 text-center">
            <p className="text-xs uppercase tracking-[0.15em] text-celestial-800/60">
              {c.kind === "instant" && c.status === "pending" ? "Call the user within" : c.status === "live" ? "Call in progress" : "Starts"}
            </p>
            <p className="font-display text-3xl font-semibold text-celestial-900">
              {c.kind === "instant" && c.status === "pending" && c.pickupBy ? (
                <Countdown to={c.pickupBy} prefix="" overdue="Overdue" />
              ) : c.status === "live" ? (
                <Countdown to={c.endAt} prefix="" overdue="Ending" />
              ) : (
                <Countdown to={c.startAt} prefix="in" overdue="Now" />
              )}
            </p>
            <p className="text-xs text-celestial-800/60">{when(c.startAt)}</p>
          </div>
          <div className="flex items-center justify-between text-sm">
            <KindBadge kind={c.kind} />
            <span className="text-celestial-800/70">
              {c.durationMinutes} min · <span className="font-semibold text-celestial-900">{inr(c.amount)}</span>
            </span>
          </div>
          <Actions c={c} />
        </li>
      ))}
    </ul>
  );
}

/* ───────────────────────────── Earnings ───────────────────────────── */

export function Earnings({ earnings }: { earnings: EarningsSummary }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard glyph="₹" label="Total earnings" value={inr(earnings.total)} hint="consultation amount" />
        <StatCard glyph="✓" label="Completed calls" value={earnings.completedCalls} />
        <StatCard glyph="◎" label="Per consultation" value={inr(earnings.averagePerCall)} hint="average" />
        <StatCard glyph="✦" label="Your payout" value={earnings.payout === null ? "—" : inr(earnings.payout)} hint={earnings.payout === null ? "provider doesn't share payout rates" : "after provider share"} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        {(
          [
            ["Today", earnings.today],
            ["This week", earnings.thisWeek],
            ["This month", earnings.thisMonth],
          ] as const
        ).map(([l, v]) => (
          <div key={l} className="rounded-xl border border-gold-300/50 bg-gold-100/40 px-4 py-3">
            <p className="text-xs text-celestial-800/60">{l}</p>
            <p className="font-display text-2xl font-semibold text-celestial-900">{inr(v)}</p>
          </div>
        ))}
      </div>
      <Panel title="Per consultation">
        {earnings.items.length === 0 ? (
          <Empty glyph="₹">Completed consultations and what each earned will appear here.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-celestial-800/50">
                <tr className="border-b border-celestial-900/10">
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">User</th>
                  <th className="py-2 pr-4 font-medium">Duration</th>
                  <th className="py-2 pr-4 font-medium">Rate</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                  <th className="py-2 text-right font-medium">Payout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-celestial-900/5 text-celestial-800">
                {earnings.items.map((c) => (
                  <tr key={c.bookingId}>
                    <td className="py-2.5 pr-4 whitespace-nowrap">{when(c.startAt)}</td>
                    <td className="py-2.5 pr-4">{userLabel(c.user)}</td>
                    <td className="py-2.5 pr-4">{c.durationMinutes} min</td>
                    <td className="py-2.5 pr-4">{inr(c.pricePerMinute)}/min</td>
                    <td className="py-2.5 pr-4 text-right font-semibold text-celestial-900">{inr(c.amount)}</td>
                    <td className="py-2.5 text-right">{c.payout === null ? "—" : inr(c.payout)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ───────────────────────────── Profile ───────────────────────────── */

const LIVE_STATUS: Record<AstrologerProfile["availability"]["status"], string> = {
  online: "Online",
  busy: "Busy",
  offline: "Offline",
  unknown: "Not reported",
};

export function Profile({ a, settings, providerName }: { a: AstrologerProfile; settings: PortalSettings; providerName: string }) {
  const labels = new Map([...config.catalog.categories, ...config.catalog.specializations, ...config.catalog.languages].map((c) => [c.id, c.label]));
  const label = (id: string) => labels.get(id) ?? id;
  const facts: [string, string][] = [
    ["Experience", a.experienceYears === null ? "—" : `${a.experienceYears} years`],
    ["Per-minute fee", `${inr(a.pricing.perMinute)}/min`],
    ["Minimum call", a.pricing.minCallMinutes ? `${a.pricing.minCallMinutes} min` : "None"],
    ["Rating", a.rating === null ? "No ratings yet" : `★ ${a.rating.toFixed(1)} (${a.reviewCount} reviews)`],
    ["Provider", providerName],
    ["Provider status", LIVE_STATUS[a.availability.status]],
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Panel className="flex flex-col items-center text-center">
        <div className="flex flex-col items-center gap-3">
          <Avatar name={a.name} src={a.avatarUrl} size="lg" />
          <div>
            <h2 className="font-display text-3xl font-semibold text-celestial-900">{a.name}</h2>
            {a.tagline && <p className="text-sm text-celestial-800/70">{a.tagline}</p>}
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ${settings.status === "available" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-zinc-100 text-zinc-600 ring-zinc-200"}`}
          >
            <span className={`h-2 w-2 rounded-full ${settings.status === "available" ? "bg-emerald-500" : "bg-zinc-400"}`} />
            {settings.status === "available" ? "Available" : "Unavailable"}
          </span>
          {a.verified && <Chip>✓ Verified</Chip>}
        </div>
      </Panel>
      <div className="flex flex-col gap-6">
        <Panel title="Details">
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs uppercase tracking-[0.15em] text-celestial-800/50">{k}</dt>
                <dd className="mt-0.5 font-medium text-celestial-900">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title="Languages & expertise">
          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-2 text-xs uppercase tracking-[0.15em] text-celestial-800/50">Languages</p>
              <div className="flex flex-wrap gap-2">{a.languages.length ? a.languages.map((l) => <Chip key={l}>{label(l)}</Chip>) : <span className="text-sm text-celestial-800/60">Not listed</span>}</div>
            </div>
            <div>
              <p className="mb-2 text-xs uppercase tracking-[0.15em] text-celestial-800/50">Expertise & topics</p>
              <div className="flex flex-wrap gap-2">
                {[...a.categories, ...a.specializations].length ? (
                  [...a.categories, ...a.specializations].map((t) => <Chip key={t}>{label(t)}</Chip>)
                ) : (
                  <span className="text-sm text-celestial-800/60">Not listed</span>
                )}
              </div>
            </div>
            {a.about && <p className="text-sm leading-relaxed text-celestial-800/80">{a.about}</p>}
          </div>
        </Panel>
        <p className="text-xs text-celestial-800/50">Profile details come from your provider ({providerName}). Contact them to change your name, photo, fee or expertise.</p>
      </div>
    </div>
  );
}

/* ───────────────────────────── Availability ───────────────────────────── */

export function AvailabilityPanel({ settings, now }: { settings: PortalSettings; now: number }) {
  const upcomingBlocks = settings.blocks.filter((b) => b.endAt > now).slice(0, 8);
  const overrides = Object.entries(settings.dayOverrides)
    .filter(([d]) => d >= todayKey(now, config.booking.utcOffsetMinutes))
    .sort(([x], [y]) => x.localeCompare(y));
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex flex-col gap-6">
        <Panel title="Status">
          <StatusToggle status={settings.status} />
        </Panel>
        <Panel title="Working hours">
          <p className="-mt-2 mb-3 text-sm text-celestial-800/60">Your regular weekly hours ({config.booking.timeZoneLabel}). Change a single date from the calendar.</p>
          <WeeklyHoursForm weeklyHours={settings.weeklyHours} />
        </Panel>
      </div>
      <Panel
        title="Time off & changes"
        action={
          <Link href="?tab=calendar" className="text-sm font-medium text-celestial-600 hover:underline">
            Open calendar →
          </Link>
        }
      >
        {upcomingBlocks.length === 0 && overrides.length === 0 ? (
          <Empty>No blocked time or special days coming up.</Empty>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {overrides.map(([d, o]) => (
              <li key={d} className="flex items-center justify-between rounded-lg bg-lavender-50 px-3 py-2">
                <span className="font-medium text-celestial-900">{d}</span>
                <span className="text-celestial-800/70">{o.off ? "Day off" : `${minutesToInput(o.startMinute)}–${minutesToInput(o.endMinute)}`}</span>
              </li>
            ))}
            {upcomingBlocks.map((b) => (
              <li key={b.id} className="flex items-center justify-between rounded-lg bg-rose-50 px-3 py-2">
                <span className="font-medium text-rose-800">
                  {when(b.startAt)} – {time(b.endAt)}
                </span>
                <span className="truncate pl-2 text-rose-700/80">{b.note ?? "Blocked"}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/* ───────────────────────────── Notifications ───────────────────────────── */

const KIND = {
  new_booking: { glyph: "✦", className: "bg-lavender-100 text-celestial-700" },
  cancellation: { glyph: "✕", className: "bg-rose-50 text-rose-700" },
  schedule_change: { glyph: "↻", className: "bg-gold-100 text-gold-600" },
} as const;

export function Notifications({ items }: { items: PortalNotification[] }) {
  const unread = items.filter((n) => !n.read).length;
  return (
    <Panel
      title="Notifications"
      action={
        unread > 0 ? (
          <ActionButton action={markReadAction} variant="ghost" pendingLabel="Marking…">
            Mark all read ({unread})
          </ActionButton>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <Empty glyph="🔔">New bookings, cancellations and schedule changes will show up here.</Empty>
      ) : (
        <ul className="divide-y divide-celestial-900/5">
          {items.map((n) => (
            <li key={n.id} className={`flex gap-3 py-3 ${n.read ? "" : "rounded-lg bg-lavender-50/70 px-2"}`}>
              <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base ${KIND[n.kind].className}`}>
                {KIND[n.kind].glyph}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className={`text-sm ${n.read ? "text-celestial-800" : "font-semibold text-celestial-900"}`}>{n.title}</p>
                  <span className="shrink-0 text-xs text-celestial-800/50">{when(n.createdAt)}</span>
                </div>
                <p className="text-sm text-celestial-800/70">{n.message}</p>
              </div>
              {!n.read && <span aria-label="Unread" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-celestial-600" />}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ───────────────────────────── History ───────────────────────────── */

const HISTORY_FILTERS = [
  ["all", "All"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
  ["rejected", "Rejected"],
  ["no_show", "No-show"],
] as const;

export function History({ items, filter }: { items: Consultation[]; filter: string }) {
  const shown = filter === "all" ? items : items.filter((c) => c.status === filter);
  return (
    <Panel
      title="Call history"
      action={
        <nav aria-label="Filter history" className="flex flex-wrap gap-1.5">
          {HISTORY_FILTERS.map(([id, l]) => {
            const count = id === "all" ? items.length : items.filter((c) => c.status === id).length;
            return (
              <Link
                key={id}
                href={`?tab=history&filter=${id}`}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${filter === id ? "bg-celestial-700 text-white" : "border border-celestial-900/10 bg-white/70 text-celestial-800 hover:bg-white"}`}
              >
                {l} · {count}
              </Link>
            );
          })}
        </nav>
      }
    >
      <ConsultationTable items={shown} empty="No consultations here yet." showActions={false} />
    </Panel>
  );
}
