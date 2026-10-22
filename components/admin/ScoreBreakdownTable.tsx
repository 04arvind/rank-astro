import type { AdjustmentExplanation, CandidateDebug, EngineInfo, PipelineTrace, ScoreExplanation } from "@/types/ranking";
import WhyDetails, { type LayerMeta } from "./WhyDetails";

interface ScoreBreakdownTableProps {
  candidates: CandidateDebug[];
  engine?: EngineInfo;
  /** Layer statuses for the per-layer "Why" sections (optional). */
  pipeline?: PipelineTrace;
}

const SCORE_COLUMNS: { name: ScoreExplanation["name"]; label: string }[] = [
  { name: "qualityScore", label: "Quality" },
  { name: "personalizationScore", label: "Personal" },
  { name: "businessScore", label: "Business" },
  { name: "priceScore", label: "Price" },
  { name: "categoryScore", label: "Category" },
  { name: "availabilityScore", label: "Avail." },
  { name: "explorationScore", label: "Explore" },
  { name: "languageScore", label: "Language" },
  { name: "diversityScore", label: "Diversity" },
];

const f2 = (n: number) => n.toFixed(2);
const f3 = (n: number) => n.toFixed(3);

function ScoreCell({ score }: { score?: ScoreExplanation }) {
  if (!score) return <td className="px-2 py-2 text-center text-zinc-300">—</td>;
  return (
    <td className="px-2 py-2" title={`${score.name}: ${f3(score.value)} × ${score.weight} = ${f3(score.contribution)}${score.missing ? " (no data → neutral)" : ""}`}>
      <div className={`font-mono text-xs ${score.missing ? "text-zinc-400" : "text-zinc-800"}`}>{f2(score.value)}</div>
      <div className="mt-0.5 h-1 w-10 rounded bg-zinc-100">
        <div className={`h-1 rounded ${score.missing ? "bg-zinc-300" : "bg-indigo-500"}`} style={{ width: `${Math.round(score.value * 100)}%` }} />
      </div>
    </td>
  );
}

function AdjustmentCell({ a }: { a?: AdjustmentExplanation }) {
  if (!a) return <td className="px-2 py-2 text-right text-zinc-300">—</td>;
  const tone = a.value > 0 ? "text-green-700" : a.value < 0 ? "text-red-600" : a.note?.startsWith("withheld") ? "text-amber-600" : "text-zinc-400";
  return (
    <td className={`px-2 py-2 text-right font-mono text-xs ${tone}`} title={a.note ?? `raw ${f3(a.raw)}, bounds [${a.bounds.join(", ")}]`}>
      {a.value > 0 ? "+" : a.value < 0 ? "−" : ""}
      {f3(Math.abs(a.value))}
      {a.note?.startsWith("withheld") && " ⊘"}
    </td>
  );
}

/** Layer 5: pre-bandit position → final position, with the Thompson draw behind it on hover. */
function ThompsonCell({ c }: { c: CandidateDebug }) {
  const t = c.thompson;
  if (!t) return <td className="px-2 py-2 text-right text-zinc-300">—</td>;
  const moved = t.layer2Rank - (c.rank ?? t.layer2Rank);
  const title =
    `pre-bandit #${t.layer2Rank} → #${c.rank} · θ sample ${t.sample.toFixed(4)} · posterior mean ${t.posteriorMean.toFixed(4)}` +
    ` (prior ${t.priorMean.toFixed(4)}) · ${t.trials.toFixed(1)} exposures / ${t.successes} completed · reward ${t.reward.toFixed(3)} · ${t.mode}, ${t.variant}`;
  return (
    <td className="px-2 py-2 text-right font-mono text-xs" title={title}>
      <span className="text-zinc-400">#{t.layer2Rank}</span>
      {moved !== 0 && <span className={moved > 0 ? "ml-1 text-green-700" : "ml-1 text-red-500"}>{moved > 0 ? `▲${moved}` : `▼${-moved}`}</span>}
      <div className="text-[10px] text-zinc-400">θ {t.sample.toFixed(3)}</div>
    </td>
  );
}

/** Admin ranking list: every score, booster, penalty and the final score per astrologer. */
export default function ScoreBreakdownTable({ candidates, engine, pipeline }: ScoreBreakdownTableProps) {
  const ranked = candidates.filter((c) => c.eligible && c.breakdown).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const excluded = candidates.filter((c) => !c.eligible);
  const cols = 5 + SCORE_COLUMNS.length + 7;
  // Layer statuses only; the per-layer lists aren't needed by the "Why" panels.
  const layerMeta: LayerMeta[] | undefined = pipeline?.layers.map(({ entries, filtered, ...meta }) => (void entries, void filtered, meta));

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
        <div>
          <h2 className="font-semibold">Ranking list</h2>
          <p className="text-xs text-zinc-500">final = base + providerBooster + quotaUrgencyBoost − frequencyPenalty · total = final + extension terms (Layer 2) · # = final position after Layers 3–6 (Thompson sampling re-assigns the top slots in Layer 5) · hover a cell for details</p>
        </div>
        <span className="text-xs text-zinc-500">
          {ranked.length} ranked · {excluded.length} excluded{engine && ` · ${engine.name}`}
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500">
            <tr>
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">Astrologer</th>
              <th className="px-2 py-2">Provider</th>
              <th className="px-2 py-2 text-right">₹/min</th>
              <th className="px-2 py-2">Status</th>
              {SCORE_COLUMNS.map((s) => (
                <th key={s.name} className="px-2 py-2">
                  {s.label}
                </th>
              ))}
              <th className="px-2 py-2 text-right">Base</th>
              <th className="px-2 py-2 text-right">Booster</th>
              <th className="px-2 py-2 text-right">Quota</th>
              <th className="px-2 py-2 text-right">Penalty</th>
              <th className="px-2 py-2 text-right">Final</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2 text-right" title="Layer 5: pre-bandit position and the Thompson move; hover for the draw">Pre → TS</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((c) => {
              const b = c.breakdown!;
              const score = (n: ScoreExplanation["name"]) => b.scores.find((s) => s.name === n);
              const adj = (n: AdjustmentExplanation["name"]) => b.adjustments.find((a) => a.name === n);
              const a = c.astrologer;
              const moved = (c.scoreRank ?? 0) - (c.rank ?? 0);
              return [
                <tr key={c.astrologerId} className="border-t border-zinc-100 hover:bg-zinc-50">
                  <td className="px-2 py-2 font-mono text-zinc-500">
                    {c.rank}
                    {moved !== 0 && (
                      <span className={`ml-1 text-[10px] ${moved > 0 ? "text-green-600" : "text-red-500"}`} title={`#${c.scoreRank} by score alone`}>
                        {moved > 0 ? "▲" : "▼"}
                        {Math.abs(moved)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="font-medium">
                      {a?.name ?? c.astrologerId}
                      {c.isExploration && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">explore</span>}
                    </div>
                    <div className="text-xs capitalize text-zinc-400">{a ? [...a.languages, ...a.categories, ...a.specializations].slice(0, 4).join(" · ") : ""}</div>
                  </td>
                  <td className="px-2 py-2 text-xs">{c.providerId}</td>
                  <td className="px-2 py-2 text-right">{a?.pricePerMinute ?? "—"}</td>
                  <td className="px-2 py-2 text-xs">
                    <span className={a?.isOnline ? "text-green-600" : "text-zinc-400"}>{a?.isOnline ? "Online" : "Not online"}</span>
                  </td>
                  {SCORE_COLUMNS.map((s) => (
                    <ScoreCell key={s.name} score={score(s.name)} />
                  ))}
                  <td className="px-2 py-2 text-right font-mono text-xs">{f3(b.baseScore)}</td>
                  <AdjustmentCell a={adj("providerBooster")} />
                  <AdjustmentCell a={adj("quotaUrgencyBoost")} />
                  <AdjustmentCell a={adj("frequencyPenalty")} />
                  <td className="px-2 py-2 text-right font-mono text-xs">{f3(b.finalScore)}</td>
                  <td className="px-2 py-2 text-right font-mono text-sm font-semibold">{f3(b.totalScore)}</td>
                  <ThompsonCell c={c} />
                </tr>,
                <tr key={`${c.astrologerId}-why`}>
                  <td />
                  <td colSpan={cols - 1} className="px-2 pb-2">
                    <WhyDetails c={{ ...c, signals: {}, explanation: undefined }} layers={layerMeta} />
                  </td>
                </tr>,
              ];
            })}
            {ranked.length === 0 && (
              <tr>
                <td colSpan={cols} className="px-4 py-8 text-center text-zinc-500">
                  No eligible astrologers for these filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {excluded.length > 0 && (
        <details className="border-t border-zinc-200 px-4 py-3 text-sm">
          <summary className="cursor-pointer text-zinc-600">{excluded.length} excluded by eligibility (not scored)</summary>
          <ul className="mt-2 grid gap-1 text-xs md:grid-cols-2">
            {excluded.map((c) => (
              <li key={c.astrologerId} className="flex justify-between gap-2 rounded bg-red-50/60 px-2 py-1">
                <span>
                  {c.astrologer?.name ?? c.astrologerId} <span className="text-zinc-400">({c.providerId})</span>
                </span>
                <span className="text-red-700">{c.exclusionReason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
