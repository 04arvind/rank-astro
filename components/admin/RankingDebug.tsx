import type { CandidateDebug, EngineInfo } from "@/types/ranking";

interface RankingDebugProps {
  candidates: CandidateDebug[];
  engine?: EngineInfo;
}

/** Per-candidate signal breakdown as returned by /api/admin/ranking/debug. */
export default function RankingDebug({ candidates, engine }: RankingDebugProps) {
  const signalNames = Array.from(new Set(candidates.flatMap((c) => Object.keys(c.signals)))).sort();
  const eligibleCount = candidates.filter((c) => c.eligible).length;

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 className="font-semibold">Signal breakdown</h2>
        <span className="text-xs text-zinc-500">
          {eligibleCount}/{candidates.length} eligible
          {engine && ` · ${engine.name} v${engine.version}`}
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2">Astrologer</th>
              <th className="px-3 py-2">Provider</th>
              <th className="px-3 py-2">Eligible</th>
              {signalNames.map((s) => (
                <th key={s} className="px-3 py-2 text-right font-mono normal-case">
                  {s}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Final</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 font-mono text-xs">
            {candidates.map((c) => (
              <tr key={c.astrologerId} className={c.eligible ? "" : "bg-red-50/50 text-zinc-400"}>
                <td className="px-3 py-2">{c.astrologerId}</td>
                <td className="px-3 py-2">{c.providerId}</td>
                <td className="px-3 py-2 font-sans">
                  {c.eligible ? (
                    <span className="text-green-600">Yes</span>
                  ) : (
                    <span className="text-red-600" title={c.exclusionReason}>
                      No{c.exclusionReason && ` — ${c.exclusionReason}`}
                    </span>
                  )}
                </td>
                {signalNames.map((s) => {
                  const v = c.signals[s];
                  return (
                    <td
                      key={s}
                      className={`px-3 py-2 text-right ${v !== undefined && v < 0 ? "text-red-600" : ""}`}
                    >
                      {v === undefined ? "—" : v.toFixed(3)}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-semibold">{c.finalScore.toFixed(4)}</td>
              </tr>
            ))}
            {candidates.length === 0 && (
              <tr>
                <td colSpan={signalNames.length + 4} className="px-3 py-8 text-center font-sans text-zinc-500">
                  No candidates
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
