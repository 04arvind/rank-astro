import type { RankingStats } from "@/types/ranking";

interface ProviderStatsProps {
  stats: RankingStats;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const ratio = (num: number, den: number) => (den > 0 ? pct(num / den) : "—");
const fmt = (n: number) => n.toLocaleString("en-IN");

const BAR_COLORS = ["bg-indigo-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500", "bg-sky-500"];

export default function ProviderStats({ stats }: ProviderStatsProps) {
  const { providers } = stats;

  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 className="font-semibold">Provider utilization</h2>
        <span className="text-xs text-zinc-500">
          Last {stats.window} · {new Date(stats.generatedAt).toLocaleString()}
        </span>
      </header>

      {/* Exposure distribution */}
      <div className="px-4 pt-4">
        <p className="mb-1 text-xs text-zinc-500">Exposure share</p>
        <div className="flex h-3 overflow-hidden rounded-full bg-zinc-100">
          {providers.map((p, i) => (
            <div
              key={p.providerId}
              title={`${p.providerId}: ${pct(p.exposureShare)}`}
              className={BAR_COLORS[i % BAR_COLORS.length]}
              style={{ width: pct(p.exposureShare) }}
            />
          ))}
        </div>
      </div>

      <div className="overflow-x-auto p-4">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500">
            <tr>
              <th className="py-2">Provider</th>
              <th className="py-2 text-right">Impressions</th>
              <th className="py-2 text-right">Clicks</th>
              <th className="py-2 text-right">CTR</th>
              <th className="py-2 text-right">Calls</th>
              <th className="py-2 text-right">Call rate</th>
              <th className="py-2 text-right">Exposure</th>
              <th className="py-2 text-right">Target</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {providers.map((p, i) => {
              const gap = p.targetShare === undefined ? undefined : p.exposureShare - p.targetShare;
              return (
                <tr key={p.providerId}>
                  <td className="py-2">
                    <span
                      className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${BAR_COLORS[i % BAR_COLORS.length]}`}
                    />
                    {p.providerId}
                  </td>
                  <td className="py-2 text-right">{fmt(p.impressions)}</td>
                  <td className="py-2 text-right">{fmt(p.clicks)}</td>
                  <td className="py-2 text-right">{ratio(p.clicks, p.impressions)}</td>
                  <td className="py-2 text-right">{fmt(p.calls)}</td>
                  <td className="py-2 text-right">{ratio(p.calls, p.clicks)}</td>
                  <td className="py-2 text-right">{pct(p.exposureShare)}</td>
                  <td className="py-2 text-right">
                    {p.targetShare === undefined ? "—" : pct(p.targetShare)}
                    {gap !== undefined && (
                      <span className={`ml-1 text-xs ${gap < 0 ? "text-red-600" : "text-green-600"}`}>
                        ({gap >= 0 ? "+" : ""}
                        {(gap * 100).toFixed(1)})
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {providers.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 text-center text-zinc-500">
                  No provider data for this window
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
