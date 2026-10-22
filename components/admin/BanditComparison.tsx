import type { CandidateDebug } from "@/types/ranking";

interface BanditComparisonProps {
  candidates: CandidateDebug[];
  /** Thompson slots firstSlot..slots (config.ranking.bandit, i.e. 3–4), shaded on both sides. */
  firstSlot: number;
  slots: number;
  /** Bandit mode and the viewer's variant for this run (pipeline trace, Layer 5). */
  mode?: string;
  variant?: string | null;
  /** Rows shown per side. */
  rows?: number;
}

type Row = CandidateDebug & { rank: number; layer2Rank: number };

function Name({ c }: { c: Row }) {
  return (
    <span className="min-w-0 truncate">
      <span className="font-medium">{c.astrologer?.name ?? c.astrologerId}</span> <span className="text-xs text-zinc-400">{c.providerId}</span>
    </span>
  );
}

/** Admin: the pre-bandit ranking (old) next to the order after Layer-5 Thompson sampling (new). */
export default function BanditComparison({ candidates, firstSlot, slots, mode, variant, rows = Math.max(20, slots + 10) }: BanditComparisonProps) {
  const ranked = candidates.filter((c): c is Row => c.eligible && c.rank !== undefined && c.layer2Rank !== undefined);
  const before = [...ranked].sort((a, b) => a.layer2Rank - b.layer2Rank).slice(0, rows);
  const after = [...ranked].sort((a, b) => a.rank - b.rank).slice(0, rows);
  const moved = ranked.filter((c) => c.rank !== c.layer2Rank).length;
  const picks = ranked.filter((c) => c.thompson).length;
  const range = firstSlot === slots ? `#${slots}` : `#${firstSlot}–#${slots}`;
  const status =
    !mode || mode === "off"
      ? "Bandit off (or unavailable): both lists are the pre-bandit ranking."
      : mode === "shadow"
        ? "Shadow mode: samples are drawn and logged, but the order is not changed."
        : variant === "control"
          ? "This user is in the holdout group: they see the pre-bandit ranking."
          : `Live: Thompson sampling recommended ${picks} astrologer${picks === 1 ? "" : "s"} for ${range} · ${moved} astrologer${moved === 1 ? "" : "s"} moved.`;

  const slotShade = (pos: number) => (pos >= firstSlot && pos <= slots ? "bg-indigo-50/60" : "");

  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      <header className="border-b border-zinc-200 px-4 py-3">
        <h2 className="font-semibold">Old ranking vs after bandit</h2>
        <p className="text-xs text-zinc-500">{status} Shaded rows are the Thompson slots ({range}); hover a pick for its draw.</p>
      </header>

      <div className="grid gap-4 p-4 md:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">Old — before Thompson sampling (Layers 2–4 + exploration slots)</p>
          <ol className="divide-y divide-zinc-100 text-sm">
            {before.map((c) => (
              <li key={c.astrologerId} className={`flex items-center gap-2 px-2 py-1 ${slotShade(c.layer2Rank)}`}>
                <span className="w-8 shrink-0 font-mono text-xs text-zinc-500">#{c.layer2Rank}</span>
                <Name c={c} />
                <span className="ml-auto shrink-0 font-mono text-xs text-zinc-400" title="totalScore">
                  {c.finalScore.toFixed(3)}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">New — after Layer 5 (Thompson sampling)</p>
          <ol className="divide-y divide-zinc-100 text-sm">
            {after.map((c) => {
              const shift = c.layer2Rank - c.rank;
              const th = c.thompson;
              const title = th
                ? `Thompson pick · was #${c.layer2Rank} · θ sample ${th.sample.toFixed(4)} · posterior mean ${th.posteriorMean.toFixed(4)} · ${th.trials.toFixed(1)} exposures / ${th.successes} completed`
                : `was #${c.layer2Rank} · not a Thompson-sampling pick`;
              return (
                <li key={c.astrologerId} className={`flex items-center gap-2 px-2 py-1 ${slotShade(c.rank)}`} title={title}>
                  <span className="w-8 shrink-0 font-mono text-xs text-zinc-500">#{c.rank}</span>
                  <Name c={c} />
                  <span className="ml-auto shrink-0 font-mono text-xs">
                    {shift > 0 && <span className="text-green-700">▲{shift} from #{c.layer2Rank}</span>}
                    {shift < 0 && <span className="text-red-500">▼{-shift} from #{c.layer2Rank}</span>}
                    {shift === 0 && <span className="text-zinc-300">—</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
