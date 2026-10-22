/**
 * Provider utilization & ranking report.
 *
 *   npm run report:providers -- [--events reports/events-….json] [--window 24h] [--out reports/x.md]
 *
 * Two parts:
 *  1. Utilization — from analytics events (load a file saved by
 *     `sim:ranking --save-events`, or historical exports): exposure vs
 *     target, engagement, revenue and capacity usage per provider.
 *  2. Ranking snapshot — runs the engine for a grid of sample requests and
 *     reports each provider's share of top slots, eligibility exclusions and
 *     average signal contributions.
 * Writes Markdown + JSON under reports/. Read-only with respect to app data.
 */
import { config } from "@/config";
import { getProviderMetrics } from "@/lib/analytics";
import { runRanking } from "@/lib/ranking";
import { isSaturated } from "@/lib/ranking/provider/utilization";
import { countBy, groupBy } from "@/lib/utils/collections";
import { mean } from "@/lib/utils/math";
import type { ProviderMetrics } from "@/types/analytics";
import type { RankingContext, StatsWindow } from "@/types/ranking";
import { args, heading, main, pct, REPORTS_DIR, stamp, writeJson, writeProjectFile } from "./_lib/cli";
import { importEvents, loadAstrologers } from "./_lib/data";

const USAGE = `
Usage: npm run report:providers -- [options]

  --events <file>    Analytics events to report on (from sim:ranking --save-events)
  --window <w>       Utilization window: 1h | 24h | 7d | 30d (default 24h)
  --from-feeds       Normalize provider feeds instead of reading the snapshot
  --out <file>       Markdown path (default reports/provider-report-<timestamp>.md)
`;

const WINDOWS: StatsWindow[] = ["1h", "24h", "7d", "30d"];

main("provider-report", async () => {
  const opts = args(USAGE, {
    events: { type: "string" },
    window: { type: "string" },
    "from-feeds": { type: "boolean" },
    out: { type: "string" },
  });
  const window = (opts.window ?? "24h") as StatsWindow;
  if (!WINDOWS.includes(window)) throw new Error(`--window must be one of ${WINDOWS.join(", ")}`);

  const { astrologers, source } = await loadAstrologers(Boolean(opts["from-feeds"]));
  const imported = opts.events ? await importEvents(opts.events) : {};
  console.log(`Astrologers: ${astrologers.length} from ${source}. Events: ${JSON.stringify(imported)}`);

  // ---- 1. utilization ---------------------------------------------------------
  const metrics = await getProviderMetrics({ window });
  const utilization = metrics.map((m) => row(m));
  heading(`Provider utilization (${window})`);
  if (!opts.events) console.log("(no --events file: utilization figures will be empty)");
  console.table(utilization);

  // ---- 2. ranking snapshot -------------------------------------------------
  const languages = [undefined, ...config.catalog.languages.slice(0, 3).map((l) => [l.id])];
  const categories = [undefined, ...config.catalog.categories.slice(0, 3).map((c) => c.id)];
  const topN = config.business.guardrails.topN;
  const topSlots = new Map<string, number>();
  const exclusions = new Map<string, Map<string, number>>();
  const contributions = new Map<string, Map<string, number[]>>();
  let requests = 0;

  for (const lang of languages) {
    for (const category of categories) {
      const ctx: RankingContext = {
        user: { sessionId: `report-${lang?.[0] ?? "any"}-${category ?? "any"}` },
        context: { languages: lang, category },
        filters: { onlineOnly: false },
        pagination: { limit: topN, offset: 0 },
      };
      const run = await runRanking(ctx);
      requests++;
      for (const c of run.ranked.slice(0, topN)) {
        const pid = c.astrologer.providerId;
        topSlots.set(pid, (topSlots.get(pid) ?? 0) + 1);
        const byProvider = contributions.get(pid) ?? new Map();
        const e = c.explanation;
        const rows: [string, number][] = [
          ...e.scores.map((s) => [s.name, s.contribution] as [string, number]),
          ...e.adjustments.map((a) => [a.name, a.value] as [string, number]),
          ["finalScore", e.finalScore],
        ];
        for (const [k, v] of rows) byProvider.set(k, [...(byProvider.get(k) ?? []), v]);
        contributions.set(pid, byProvider);
      }
      if (lang === undefined && category === undefined) {
        for (const [pid, list] of groupBy(run.excluded, (e) => e.astrologer.providerId)) {
          exclusions.set(pid, countBy(list.flatMap((e) => e.reasons), (x) => x));
        }
      }
    }
  }

  const totalSlots = [...topSlots.values()].reduce((a, b) => a + b, 0);
  const snapshot = config.providers.providers.map((p) => ({
    provider: p.id,
    name: p.name,
    astrologers: astrologers.filter((a) => a.providerId === p.id).length,
    topSlotShare: pct(totalSlots ? (topSlots.get(p.id) ?? 0) / totalSlots : null),
    target: pct(p.targetShare, 0),
    excluded: Object.fromEntries(exclusions.get(p.id) ?? []),
  }));
  heading(`Ranking snapshot: provider share of top ${topN} across ${requests} sample requests`);
  console.table(snapshot.map(({ excluded, ...r }) => ({ ...r, excluded: JSON.stringify(excluded) })));

  const signals = [...new Set([...contributions.values()].flatMap((m) => [...m.keys()]))];
  const signalTable = signals.map((s) => ({
    signal: s,
    ...Object.fromEntries(config.providers.providers.map((p) => [p.id, mean(contributions.get(p.id)?.get(s) ?? [])?.toFixed(3) ?? "—"])),
  }));
  heading("Average score contribution / adjustment in top slots, by provider");
  console.table(signalTable);

  // ---- output -------------------------------------------------------------------
  const ts = stamp();
  const md = [
    `# Provider report — ${new Date().toISOString()}`,
    "",
    `Astrologers: ${astrologers.length} (${source}). Events: ${JSON.stringify(imported)}. Window: ${window}.`,
    "",
    `## Utilization (${window})`,
    table(utilization),
    "",
    `## Ranking snapshot — share of top ${topN} over ${requests} sample requests`,
    table(snapshot.map(({ excluded, ...r }) => ({ ...r, excluded: Object.entries(excluded).map(([k, v]) => `${k}: ${v}`).join(", ") || "—" }))),
    "",
    "## Average score contribution / adjustment in top slots",
    table(signalTable),
    "",
  ].join("\n");

  const mdFile = await writeProjectFile(opts.out ?? `${REPORTS_DIR}/provider-report-${ts}.md`, md);
  const jsonFile = await writeJson(`${REPORTS_DIR}/provider-report-${ts}.json`, { window, utilization: metrics, snapshot, signalTable });
  console.log(`\nReport → ${mdFile} (+ ${jsonFile})`);
});

function row(m: ProviderMetrics) {
  const util = Math.max(m.avgUtilization ?? 0, m.peakUtilization ?? 0);
  return {
    provider: m.providerId,
    impressions: m.impressions,
    exposure: pct(m.exposureShare),
    target: pct(m.targetShare ?? null, 0),
    gap: m.targetShare === undefined ? "—" : `${((m.targetShare - m.exposureShare) * 100).toFixed(1)}pp`,
    clicks: m.clicks,
    ctr: pct(m.ctr),
    calls: m.completedCalls,
    conversion: pct(m.conversionRate),
    revenue: Math.round(m.grossRevenue),
    platformRevenue: Math.round(m.platformRevenue),
    avgUtil: pct(m.avgUtilization),
    peakUtil: pct(m.peakUtilization),
    saturated: isSaturated(util) ? "yes" : "no",
  };
}

function table(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "_No data._";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|");
  return [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${cols.map((c) => esc(r[c])).join(" | ")} |`)].join("\n");
}
