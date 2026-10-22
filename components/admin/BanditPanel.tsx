import type { BanditReport } from "@/lib/ranking/bandit";

interface BanditPanelProps {
  report: BanditReport;
}

const pct = (n: number | null, digits = 2) => (n === null ? "—" : `${(n * 100).toFixed(digits)}%`);
const inr = (n: number | null) => (n === null ? "—" : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const ago = (t: number | null) => (t === null ? "never" : new Date(t).toLocaleString());

/** Thompson-sampling health: mode, measured lift vs holdout, provider exposure, learning lag. */
export default function BanditPanel({ report: r }: BanditPanelProps) {
  const modeTone = r.mode.mode === "live" ? "bg-green-100 text-green-800" : r.mode.mode === "shadow" ? "bg-amber-100 text-amber-800" : "bg-zinc-200 text-zinc-700";
  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
        <div>
          <h2 className="font-semibold">Layer 5 — Thompson sampling</h2>
          <p className="text-xs text-zinc-500">
            Re-assigns the top {r.slots} slots of User-Choice lists (scores untouched) · reward = attributed completed consultation · policy {r.policy} · holdout{" "}
            {pct(r.holdoutShare, 0)}
          </p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${modeTone}`} title={`set by ${r.mode.source}`}>
          {r.mode.mode} ({r.mode.source})
        </span>
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-zinc-500">Last {r.windowDays} days · treatment vs holdout</p>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1">Variant</th>
                <th className="py-1 text-right">Exposures</th>
                <th className="py-1 text-right">Completed</th>
                <th className="py-1 text-right">Rate (95% CI)</th>
                <th className="py-1 text-right">Margin / exposure</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {r.variants.map((v) => (
                <tr key={v.variant} className="border-t border-zinc-100">
                  <td className="py-1 font-sans">{v.variant}</td>
                  <td className="py-1 text-right">{v.exposures.toLocaleString("en-IN")}</td>
                  <td className="py-1 text-right">{v.completions}</td>
                  <td className="py-1 text-right">
                    {pct(v.rate)} {v.interval && <span className="text-zinc-400">[{pct(v.interval[0])}, {pct(v.interval[1])}]</span>}
                  </td>
                  <td className="py-1 text-right">{inr(v.marginPerExposure)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-zinc-600">
            {r.lift === null
              ? "No lift estimate yet: both variants need exposures."
              : r.lift.significant
                ? `Rate difference ${pct(r.lift.rateDiff)} [${pct(r.lift.interval[0])}, ${pct(r.lift.interval[1])}] — significant at 95%.`
                : `Rate difference ${pct(r.lift.rateDiff)} [${pct(r.lift.interval[0])}, ${pct(r.lift.interval[1])}] — not significant; no improvement can be claimed.`}
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs text-zinc-500">Provider exposure (bandit-logged)</p>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1">Provider</th>
                <th className="py-1 text-right">Share</th>
                <th className="py-1 text-right">Target</th>
                <th className="py-1 text-right">Completed</th>
                <th className="py-1 text-right">Margin</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {r.providers.map((p) => (
                <tr key={p.providerId} className="border-t border-zinc-100">
                  <td className="py-1 font-sans">{p.providerId}</td>
                  <td className="py-1 text-right">{pct(p.exposureShare, 1)}</td>
                  <td className="py-1 text-right">{pct(p.targetShare, 0)}</td>
                  <td className="py-1 text-right">{p.completions}</td>
                  <td className="py-1 text-right">{inr(p.margin)}</td>
                </tr>
              ))}
              {r.providers.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-2 text-zinc-400">
                    No exposures logged yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-zinc-500">
            Outcomes: {r.outcomes.applied} credited · {r.outcomes.unattributed} unattributed · {r.outcomes.pending} pending · last reconcile {ago(r.reconcile.lastRunAt)}
            {r.reconcile.lagSeconds !== null && ` (lag ${r.reconcile.lagSeconds}s)`}
          </p>
        </div>
      </div>

      {r.topArms.length > 0 && (
        <details className="border-t border-zinc-200 px-4 py-3 text-sm">
          <summary className="cursor-pointer text-zinc-600">Most-exposed arms ({r.topArms.length})</summary>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1">Astrologer</th>
                <th className="py-1">Context</th>
                <th className="py-1">Provider</th>
                <th className="py-1 text-right">Trials</th>
                <th className="py-1 text-right">Completed</th>
                <th className="py-1 text-right">Rate (95% CI)</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {r.topArms.map((a) => (
                <tr key={a.id} className="border-t border-zinc-100">
                  <td className="py-1">{a.astrologerId}</td>
                  <td className="py-1">{a.context}</td>
                  <td className="py-1">{a.providerId}</td>
                  <td className="py-1 text-right">{a.trials.toFixed(1)}</td>
                  <td className="py-1 text-right">{a.successes}</td>
                  <td className="py-1 text-right">
                    {pct(a.mean)} <span className="text-zinc-400">[{pct(a.interval[0])}, {pct(a.interval[1])}]</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
