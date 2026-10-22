"use client";

import { Fragment, useMemo, useState } from "react";
import type { BusinessPillarName, BusinessPillars, PipelineLayer, PipelineLayerKey, PipelineTrace } from "@/types/ranking";

/** Per-astrologer facts the pipeline view shows; built server-side from CandidateDebug. */
export interface PipelineCandidate {
  id: string;
  name: string;
  providerId: string;
  pricePerMinute: number | null;
  online: boolean;
  isExploration: boolean;
  totalScore: number | null;
  pillars?: BusinessPillars;
  ml?: { score: number; rescaled: number; orderScore: number; model: string };
  thompson?: { sample: number; posteriorMean: number; reward: number; fairness?: number; trials: number; successes: number; mode: string; variant: string };
  notes: string[];
  exclusionReason?: string;
}

export interface PipelineProvider {
  id: string;
  name: string;
  targetShare: number;
  min: number;
  max: number;
}

interface RankingPipelineProps {
  pipeline: PipelineTrace;
  candidates: PipelineCandidate[];
  providers: PipelineProvider[];
  /** Top-N window the business guardrails and exposure shares use. */
  topN: number;
}

const PILLARS: { name: BusinessPillarName; label: string; color: string }[] = [
  { name: "bookingProbability", label: "Booking prob.", color: "bg-sky-500" },
  { name: "profit", label: "Profit / margin", color: "bg-emerald-500" },
  { name: "quality", label: "Quality", color: "bg-indigo-500" },
  { name: "personalization", label: "Personalization", color: "bg-fuchsia-500" },
  { name: "availability", label: "Availability", color: "bg-amber-500" },
  { name: "utilization", label: "Utilization", color: "bg-teal-500" },
  { name: "exposureFairness", label: "Exposure fairness", color: "bg-orange-500" },
  { name: "model", label: "Model blend", color: "bg-zinc-500" },
];

const STATUS: Record<PipelineLayer["status"], { label: string; cls: string }> = {
  applied: { label: "applied", cls: "bg-emerald-50 text-emerald-700" },
  passthrough: { label: "no change", cls: "bg-zinc-100 text-zinc-600" },
  fallback: { label: "fallback", cls: "bg-amber-50 text-amber-800" },
};

const f3 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toFixed(3));
const pct = (n: number) => `${Math.round(n * 100)}%`;

function Movement({ from, to }: { from: number | undefined; to: number }) {
  if (from === undefined) return <span className="text-indigo-600">new</span>;
  const d = from - to;
  if (d > 0) return <span className="text-green-700">▲{d}</span>;
  if (d < 0) return <span className="text-red-500">▼{-d}</span>;
  return <span className="text-zinc-300">—</span>;
}

function LayerStrip({ layers, focus, onFocus }: { layers: PipelineLayer[]; focus: PipelineLayerKey; onFocus: (k: PipelineLayerKey) => void }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
      {layers.map((l, i) => {
        const s = STATUS[l.status];
        const active = l.key === focus;
        return (
          <li key={l.key} className="relative">
            <button
              type="button"
              onClick={() => onFocus(l.key)}
              className={`flex h-full w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${active ? "border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500" : "border-zinc-200 bg-white hover:bg-zinc-50"}`}
              title={l.description}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Layer {l.layer}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s.cls}`}>{s.label}</span>
              </span>
              <span className="font-semibold text-zinc-900">{l.title}</span>
              <span className="font-mono text-xs text-zinc-600">
                {l.inputCount} → {l.outputCount}
                {l.filtered.length > 0 && <span className="text-red-600"> (−{l.filtered.length})</span>}
                <span className="text-zinc-400"> · {l.durationMs.toFixed(1)} ms</span>
              </span>
              {l.note && <span className="line-clamp-2 text-[11px] text-zinc-500">{l.note}</span>}
            </button>
            {i < layers.length - 1 && <span className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-zinc-300 lg:block">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

function PillarBreakdown({ c }: { c: PipelineCandidate }) {
  if (!c.pillars) return <p className="text-zinc-400">No business breakdown (not scored).</p>;
  const total = PILLARS.reduce((s, p) => s + Math.abs(c.pillars![p.name].contribution), 0) || 1;
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded bg-zinc-100" title="Share of |contribution| per pillar">
        {PILLARS.map((p) => {
          const v = Math.abs(c.pillars![p.name].contribution);
          return v > 0 ? <div key={p.name} className={p.color} style={{ width: `${(v / total) * 100}%` }} /> : null;
        })}
      </div>
      <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
        {PILLARS.map((p) => {
          const x = c.pillars![p.name];
          if (x.contribution === 0 && x.value === null) return null;
          return (
            <div key={p.name} className="flex items-center justify-between gap-2" title={x.sources.join(", ")}>
              <span className="flex items-center gap-1.5">
                <span className={`inline-block h-2 w-2 rounded-sm ${p.color}`} />
                {p.label}
                {x.value !== null && <span className="text-zinc-400">({x.value.toFixed(2)})</span>}
              </span>
              <span className={`font-mono ${x.contribution < 0 ? "text-red-600" : "text-zinc-800"}`}>
                {x.contribution >= 0 ? "+" : "−"}
                {Math.abs(x.contribution).toFixed(4)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="font-mono text-zinc-500">Σ pillars = totalScore {f3(c.totalScore)}</p>
    </div>
  );
}

function CandidateDetails({ c }: { c: PipelineCandidate }) {
  return (
    <div className="grid gap-4 rounded-lg bg-zinc-50 p-3 text-xs md:grid-cols-3">
      <div>
        <p className="mb-1 font-medium text-zinc-700">Layer 2 — business score</p>
        <PillarBreakdown c={c} />
      </div>
      <div className="space-y-2">
        <div>
          <p className="mb-1 font-medium text-zinc-700">Layer 4 — learned ranker</p>
          {c.ml ? (
            <p className="font-mono text-zinc-600">
              model {c.ml.score.toFixed(4)} → rescaled {c.ml.rescaled.toFixed(4)} → orderScore {c.ml.orderScore.toFixed(4)}
              <span className="block text-zinc-400">{c.ml.model}</span>
            </p>
          ) : (
            <p className="text-zinc-400">Not scored by a model (fallback, or outside the shortlist).</p>
          )}
        </div>
        <div>
          <p className="mb-1 font-medium text-zinc-700">Layer 5 — Thompson sampling</p>
          {c.thompson ? (
            <p className="font-mono text-zinc-600">
              θ {c.thompson.sample.toFixed(4)} · mean {c.thompson.posteriorMean.toFixed(4)} · reward {c.thompson.reward.toFixed(3)}
              {c.thompson.fairness !== undefined && c.thompson.fairness !== 1 && ` · fairness ×${c.thompson.fairness.toFixed(3)}`}
              <span className="block text-zinc-400">
                {c.thompson.trials.toFixed(1)} exposures / {c.thompson.successes} completed · {c.thompson.mode}, {c.thompson.variant}
              </span>
            </p>
          ) : (
            <p className="text-zinc-400">Not a Thompson-sampling pick (picks are only shown at #3–#4).</p>
          )}
          {c.isExploration && <p className="mt-1 text-amber-700">Placed in an exploration slot.</p>}
        </div>
      </div>
      <div>
        <p className="mb-1 font-medium text-zinc-700">Why it moved</p>
        {c.notes.length ? (
          <ul className="list-disc space-y-0.5 pl-4 text-zinc-600">
            {c.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : (
          <p className="text-zinc-400">Kept its score position.</p>
        )}
      </div>
    </div>
  );
}

function CompareTable({ base, focus, byId, limit }: { base: PipelineLayer; focus: PipelineLayer; byId: Map<string, PipelineCandidate>; limit: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const baseRank = new Map(base.entries.map((e) => [e.astrologerId, e.rank]));
  const unordered = base.key === "eligibility";
  const rows = focus.entries.slice(0, limit);
  const removed = base.entries.filter((e) => !focus.entries.some((x) => x.astrologerId === e.astrologerId));
  const moved = focus.entries.filter((e) => !unordered && baseRank.has(e.astrologerId) && baseRank.get(e.astrologerId) !== e.rank).length;

  return (
    <div className="overflow-x-auto">
      <p className="px-4 pb-2 text-xs text-zinc-500">
        Layer {base.layer} → Layer {focus.layer}: {unordered ? "Layer 1 is the unordered eligible set" : `${moved} position change${moved === 1 ? "" : "s"}`}
        {removed.length > 0 && ` · ${removed.length} removed`} · ordered by <span className="font-mono">{focus.scoreLabel}</span> · click a row for its breakdown
      </p>
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-xs text-zinc-500">
          <tr>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Astrologer</th>
            <th className="px-3 py-2">Provider</th>
            <th className="px-3 py-2 text-right">₹/min</th>
            <th className="px-3 py-2 text-right">Score (L{focus.layer})</th>
            <th className="px-3 py-2 text-right">Was (L{base.layer})</th>
            <th className="px-3 py-2 text-right">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const c = byId.get(e.astrologerId);
            const was = baseRank.get(e.astrologerId);
            const isOpen = open === e.astrologerId;
            return (
              <Fragment key={e.astrologerId}>
                <tr className={`cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 ${e.rank <= 10 ? "" : "text-zinc-600"}`} onClick={() => setOpen(isOpen ? null : e.astrologerId)}>
                  <td className="px-3 py-1.5 font-mono text-zinc-500">{e.rank}</td>
                  <td className="px-3 py-1.5">
                    <span className="font-medium">{c?.name ?? e.astrologerId}</span>
                    {c?.isExploration && focus.layer >= 5 && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">explore</span>}
                    {!c?.online && <span className="ml-1 text-[10px] text-zinc-400">not online</span>}
                  </td>
                  <td className="px-3 py-1.5 text-xs">{e.providerId}</td>
                  <td className="px-3 py-1.5 text-right text-xs">{c?.pricePerMinute ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">{f3(e.score)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-zinc-400">{unordered ? (was !== undefined ? "eligible" : "—") : was !== undefined ? `#${was}` : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">{unordered ? <span className="text-zinc-300">—</span> : <Movement from={was} to={e.rank} />}</td>
                </tr>
                {isOpen && c && (
                  <tr>
                    <td />
                    <td colSpan={6} className="px-3 pb-3">
                      <CandidateDetails c={c} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                No astrologers at this layer
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Rows: the final list; columns: position after each layer. */
function JourneyMatrix({ layers, byId, limit }: { layers: PipelineLayer[]; byId: Map<string, PipelineCandidate>; limit: number }) {
  const ordered = layers.filter((l) => l.key !== "eligibility");
  const final = layers.find((l) => l.key === "final");
  const ranks = ordered.map((l) => new Map(l.entries.map((e) => [e.astrologerId, e.rank])));
  const rows = (final?.entries ?? []).slice(0, limit);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-xs text-zinc-500">
          <tr>
            <th className="px-3 py-2">Astrologer</th>
            {ordered.map((l) => (
              <th key={l.key} className="px-3 py-2 text-center" title={l.description}>
                L{l.layer} {l.title}
              </th>
            ))}
            <th className="px-3 py-2 text-right" title="Layer 2 (pure business score) → final">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const c = byId.get(e.astrologerId);
            const first = ranks[0].get(e.astrologerId);
            return (
              <tr key={e.astrologerId} className="border-t border-zinc-100">
                <td className="px-3 py-1.5">
                  <span className="font-medium">{c?.name ?? e.astrologerId}</span> <span className="text-xs text-zinc-400">{e.providerId}</span>
                </td>
                {ordered.map((l, i) => {
                  const r = ranks[i].get(e.astrologerId);
                  const prev = i > 0 ? ranks[i - 1].get(e.astrologerId) : undefined;
                  const d = r !== undefined && prev !== undefined ? prev - r : 0;
                  const tone = d > 0 ? "bg-green-50 text-green-800" : d < 0 ? "bg-red-50 text-red-700" : "text-zinc-600";
                  return (
                    <td key={l.key} className="px-3 py-1.5 text-center font-mono text-xs">
                      <span className={`inline-block min-w-12 rounded px-1 ${tone}`}>
                        {r === undefined ? "—" : `#${r}`}
                        {d !== 0 && <span className="ml-0.5 text-[10px]">{d > 0 ? `▲${d}` : `▼${-d}`}</span>}
                      </span>
                    </td>
                  );
                })}
                <td className="px-3 py-1.5 text-right font-mono text-xs">
                  <Movement from={first} to={e.rank} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FilteredPanel({ layers, byId }: { layers: PipelineLayer[]; byId: Map<string, PipelineCandidate> }) {
  const withDrops = layers.filter((l) => l.filtered.length > 0);
  if (!withDrops.length) return <p className="px-4 py-3 text-sm text-zinc-500">No candidate was filtered out at any layer.</p>;
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-3">
      {withDrops.map((l) => {
        const counts = new Map<string, number>();
        for (const f of l.filtered) for (const r of f.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
        return (
          <div key={l.key} className="rounded-lg border border-zinc-200">
            <p className="border-b border-zinc-200 px-3 py-2 text-sm font-medium">
              Layer {l.layer} — {l.title} <span className="text-zinc-400">· {l.filtered.length} removed</span>
            </p>
            <div className="flex flex-wrap gap-1 px-3 py-2">
              {[...counts].sort((a, b) => b[1] - a[1]).map(([r, n]) => (
                <span key={r} className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700">
                  {r} × {n}
                </span>
              ))}
            </div>
            <ul className="max-h-64 divide-y divide-zinc-100 overflow-y-auto text-xs">
              {l.filtered.map((f) => (
                <li key={f.astrologerId} className="flex justify-between gap-2 px-3 py-1">
                  <span className="truncate">
                    {byId.get(f.astrologerId)?.name ?? f.astrologerId} <span className="text-zinc-400">({f.providerId})</span>
                  </span>
                  <span className="shrink-0 text-right text-red-700">{f.reasons.join(", ")}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ExposurePanel({ layers, providers, topN }: { layers: PipelineLayer[]; providers: PipelineProvider[]; topN: number }) {
  const shareAt = (l: PipelineLayer, pid: string) => {
    const window = l.key === "eligibility" ? l.entries : l.entries.slice(0, topN);
    if (!window.length) return null;
    return window.filter((e) => e.providerId === pid).length / window.length;
  };
  return (
    <div className="overflow-x-auto">
      <p className="px-4 pb-2 text-xs text-zinc-500">
        Share of the top {topN} per provider after each layer (Layer 1: share of eligible supply). Bar = share, tick = target; red when outside the configured min–max.
      </p>
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-xs text-zinc-500">
          <tr>
            <th className="px-3 py-2">Provider</th>
            <th className="px-3 py-2 text-right">Target (min–max)</th>
            {layers.map((l) => (
              <th key={l.key} className="px-3 py-2">
                L{l.layer} {l.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.id} className="border-t border-zinc-100">
              <td className="px-3 py-2">
                <span className="font-medium">{p.name}</span> <span className="text-xs text-zinc-400">{p.id}</span>
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">
                {pct(p.targetShare)} <span className="text-zinc-400">({pct(p.min)}–{pct(p.max)})</span>
              </td>
              {layers.map((l) => {
                const s = shareAt(l, p.id);
                const out = s !== null && l.key !== "eligibility" && (s < p.min || s > p.max);
                return (
                  <td key={l.key} className="px-3 py-2">
                    {s === null ? (
                      <span className="text-zinc-300">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="relative h-2 w-20 rounded bg-zinc-100">
                          <div className={`h-2 rounded ${out ? "bg-red-400" : "bg-indigo-500"}`} style={{ width: pct(s) }} />
                          <div className="absolute -top-0.5 h-3 w-px bg-zinc-700" style={{ left: pct(p.targetShare) }} />
                        </div>
                        <span className={`font-mono text-xs ${out ? "text-red-600" : ""}`}>{pct(s)}</span>
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type View = "compare" | "journey" | "filtered" | "exposure";

/** Admin: the ranked list after each of the six layers, and how each layer changed it. */
export default function RankingPipeline({ pipeline, candidates, providers, topN }: RankingPipelineProps) {
  const layers = pipeline.layers;
  const [focus, setFocus] = useState<PipelineLayerKey>("final");
  const [baseKey, setBaseKey] = useState<PipelineLayerKey | "previous">("previous");
  const [limit, setLimit] = useState(25);
  const [view, setView] = useState<View>("compare");
  const byId = useMemo(() => new Map(candidates.map((c) => [c.id, c])), [candidates]);

  const focusLayer = layers.find((l) => l.key === focus) ?? layers.at(-1)!;
  const prev = layers[Math.max(0, layers.indexOf(focusLayer) - 1)];
  const baseLayer = baseKey === "previous" ? prev : (layers.find((l) => l.key === baseKey) ?? prev);

  if (!layers.length) return null;
  const tabs: { id: View; label: string }[] = [
    { id: "compare", label: "Compare layers" },
    { id: "journey", label: "Rank journey" },
    { id: "filtered", label: `Filtered (${layers.reduce((s, l) => s + l.filtered.length, 0)})` },
    { id: "exposure", label: "Provider exposure" },
  ];

  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-zinc-200 px-4 py-3">
        <div>
          <h2 className="font-semibold">Ranking pipeline — step by step</h2>
          <p className="text-xs text-zinc-500">
            The astrologer list after each layer. Pick a layer card to inspect it; compare any two layers to see what that step changed. Run took {pipeline.totalMs.toFixed(1)} ms.
          </p>
        </div>
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          Rows
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="rounded border border-zinc-300 px-1 py-0.5 text-sm text-zinc-800">
            {[10, 25, 50, 100, 1000].map((n) => (
              <option key={n} value={n}>
                {n === 1000 ? "all" : n}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="space-y-3 p-4">
        <LayerStrip layers={layers} focus={focusLayer.key} onFocus={(k) => (setFocus(k), setView("compare"))} />
        <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          <span className="font-medium text-zinc-800">
            Layer {focusLayer.layer} — {focusLayer.title}:
          </span>{" "}
          {focusLayer.description}
          {focusLayer.details && (
            <span className="mt-1 block font-mono text-[11px] text-zinc-500">
              {Object.entries(focusLayer.details)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([k, v]) => `${k}=${v}`)
                .join(" · ")}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-y border-zinc-200 px-4 py-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setView(t.id)}
            className={`rounded px-2.5 py-1 text-sm ${view === t.id ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"}`}
          >
            {t.label}
          </button>
        ))}
        {view === "compare" && (
          <span className="ml-auto flex items-center gap-1 text-xs text-zinc-500">
            Compare
            <select value={baseKey} onChange={(e) => setBaseKey(e.target.value as PipelineLayerKey | "previous")} className="rounded border border-zinc-300 px-1 py-0.5 text-sm text-zinc-800">
              <option value="previous">previous layer</option>
              {layers.map((l) => (
                <option key={l.key} value={l.key}>
                  L{l.layer} {l.title}
                </option>
              ))}
            </select>
            →
            <select value={focusLayer.key} onChange={(e) => setFocus(e.target.value as PipelineLayerKey)} className="rounded border border-zinc-300 px-1 py-0.5 text-sm text-zinc-800">
              {layers.map((l) => (
                <option key={l.key} value={l.key}>
                  L{l.layer} {l.title}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>

      <div className="py-3">
        {view === "compare" && <CompareTable base={baseLayer} focus={focusLayer} byId={byId} limit={limit} />}
        {view === "journey" && <JourneyMatrix layers={layers} byId={byId} limit={limit} />}
        {view === "filtered" && <FilteredPanel layers={layers} byId={byId} />}
        {view === "exposure" && <ExposurePanel layers={layers} providers={providers} topN={topN} />}
      </div>
    </section>
  );
}
