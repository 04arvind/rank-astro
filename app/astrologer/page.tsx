import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import CalendarView from "@/components/astrologer-portal/CalendarView";
import { AutoRefresh } from "@/components/astrologer-portal/client";
import { AvailabilityPanel, ConsultationTable, Earnings, History, Notifications, Overview, Profile, UpcomingCalls } from "@/components/astrologer-portal/sections";
import { Avatar, Panel } from "@/components/astrologer-portal/ui";
import { config } from "@/config";
import {
  getPortalSettings,
  isHistory,
  isUpcoming,
  listConsultations,
  listNotifications,
  summarizeEarnings,
  toCalendarEvents,
  todaysCalls,
} from "@/lib/astrologer-portal";
import { display } from "../_components/fonts";
import { getSignedInAstrologer } from "../_lib/astrologerSession";
import { logoutAstrologer } from "./actions";

export const metadata = { title: "Astrologer dashboard" };

const TABS = [
  { id: "overview", label: "Overview", glyph: "☉" },
  { id: "calendar", label: "Calendar", glyph: "☾" },
  { id: "requests", label: "Call requests", glyph: "✦" },
  { id: "upcoming", label: "Upcoming calls", glyph: "◷" },
  { id: "earnings", label: "Earnings", glyph: "₹" },
  { id: "profile", label: "Profile", glyph: "✴" },
  { id: "availability", label: "Availability", glyph: "◐" },
  { id: "notifications", label: "Notifications", glyph: "🔔" },
  { id: "history", label: "Call history", glyph: "↺" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Everything the dashboard shows, as of now. */
async function loadDashboard(astrologerId: string) {
  const now = Date.now();
  const [consultations, settings, notifications] = await Promise.all([
    listConsultations(astrologerId, now),
    getPortalSettings(astrologerId),
    listNotifications(astrologerId, now),
  ]);
  return { now, consultations, settings, notifications };
}

export default async function AstrologerDashboard(props: PageProps<"/astrologer">) {
  await connection();
  const astrologer = await getSignedInAstrologer();
  if (!astrologer) redirect("/astrologer/login");

  const sp = await props.searchParams;
  const tab: Tab = TABS.find((t) => t.id === first(sp.tab))?.id ?? "overview";
  const { now, consultations, settings, notifications } = await loadDashboard(astrologer.id);
  const upcoming = consultations.filter(isUpcoming).sort((x, y) => x.startAt - y.startAt);
  const pending = consultations.filter((c) => c.status === "pending").sort((x, y) => x.startAt - y.startAt);
  const history = consultations.filter(isHistory);
  const earnings = summarizeEarnings(consultations, now);
  const unread = notifications.filter((n) => !n.read).length;
  const providerName = config.providers.providers.find((p) => p.id === astrologer.providerId)?.name ?? astrologer.providerId;
  const badge: Partial<Record<Tab, number>> = { requests: pending.length, upcoming: upcoming.length, notifications: unread };
  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className={`${display.variable} flex-1 bg-gradient-to-b from-ivory-50 via-lavender-50 to-ivory-100`}>
      <AutoRefresh seconds={20} />
      <header className="border-b border-celestial-900/10 bg-white/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={astrologer.name} src={astrologer.avatarUrl} />
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.25em] text-gold-600">✦ Astrologer dashboard</p>
              <p className="truncate font-display text-xl font-semibold text-celestial-900">{astrologer.name}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={`hidden items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 sm:inline-flex ${settings.status === "available" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-zinc-100 text-zinc-600 ring-zinc-200"}`}
            >
              <span className={`h-2 w-2 rounded-full ${settings.status === "available" ? "bg-emerald-500" : "bg-zinc-400"}`} />
              {settings.status === "available" ? "Available" : "Unavailable"}
            </span>
            <Link href="?tab=notifications" aria-label={`Notifications (${unread} unread)`} className="relative rounded-full p-2 text-lg text-celestial-700 hover:bg-lavender-100">
              🔔
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-celestial-600 px-1 text-[10px] font-semibold text-white">{unread}</span>
              )}
            </Link>
            <form action={logoutAstrologer}>
              <button type="submit" className="rounded-full border border-celestial-900/15 px-3 py-1.5 text-xs font-medium text-celestial-800 hover:bg-white">
                Switch profile
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row lg:py-8">
        <nav aria-label="Dashboard sections" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:w-56 lg:shrink-0 lg:overflow-visible lg:px-0">
          <ul className="flex gap-2 lg:sticky lg:top-6 lg:flex-col lg:gap-1">
            {TABS.map((t) => (
              <li key={t.id} className="shrink-0">
                <Link
                  href={`?tab=${t.id}`}
                  aria-current={tab === t.id ? "page" : undefined}
                  className={`flex items-center gap-2.5 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition lg:rounded-xl ${
                    tab === t.id ? "bg-celestial-700 text-white shadow-md" : "bg-white/60 text-celestial-800 hover:bg-white lg:bg-transparent lg:hover:bg-white/70"
                  }`}
                >
                  <span aria-hidden="true" className={tab === t.id ? "text-gold-300" : "text-gold-600"}>
                    {t.glyph}
                  </span>
                  <span className="flex-1">{t.label}</span>
                  {!!badge[t.id] && (
                    <span className={`rounded-full px-1.5 text-[11px] font-semibold ${tab === t.id ? "bg-white/20 text-white" : "bg-gold-100 text-gold-600"}`}>{badge[t.id]}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1">
          <h1 className="mb-5 font-display text-4xl font-semibold tracking-tight text-celestial-900">{current.label}</h1>
          {tab === "overview" && <Overview today={todaysCalls(consultations, now)} upcoming={upcoming} pending={pending} earnings={earnings} unread={unread} />}
          {tab === "calendar" && (
            <Panel>
              <CalendarView settings={{ weeklyHours: settings.weeklyHours, dayOverrides: settings.dayOverrides, blocks: settings.blocks }} events={toCalendarEvents(consultations)} now={now} />
            </Panel>
          )}
          {tab === "requests" && (
            <Panel>
              <ConsultationTable items={[...consultations].sort((x, y) => y.requestedAt - x.requestedAt)} empty="No call requests yet." />
            </Panel>
          )}
          {tab === "upcoming" && <UpcomingCalls items={upcoming} />}
          {tab === "earnings" && <Earnings earnings={earnings} />}
          {tab === "profile" && <Profile a={astrologer} settings={settings} providerName={providerName} />}
          {tab === "availability" && <AvailabilityPanel settings={settings} now={now} />}
          {tab === "notifications" && <Notifications items={notifications} />}
          {tab === "history" && <History items={history} filter={first(sp.filter) ?? "all"} />}
        </main>
      </div>
    </div>
  );
}
