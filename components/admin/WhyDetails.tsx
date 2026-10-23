"use client";

import { Fragment, useState, type ReactNode } from "react";
import type { BusinessPillarName, CandidateDebug, PipelineLayer, PipelineLayerKey } from "@/types/ranking";

/*
 * The ranking list's "Why #N?" panel: every parameter of every pipeline
 * layer for one astrologer. Its content is built only when opened, so the
 * list doesn't render (and ship) ~100 full breakdowns up front.
 */

/** A layer's run status without its per-astrologer lists. */
export type LayerMeta = Omit<PipelineLayer, "entries" | "filtered">;

const f2 = (n: number) => n.toFixed(2);
const f3 = (n: number) => n.toFixed(3);

const LAYER_ORDER: PipelineLayerKey[] = ["eligibility", "business", "candidates", "ml", "exploration", "final"];
const LAYER_TITLE: Record<PipelineLayerKey, string> = {
  eligibility: "Eligibility",
  business: "Business ranking",
  candidates: "Candidate generation",
  ml: "ML ranking",
  exploration: "Exploration",
  final: "Final re-ranking",
};
const PILLAR_LABEL: Record<BusinessPillarName, string> = {
  bookingProbability: "Booking probability",
  profit: "Profit / margin",
  quality: "Quality",
  personalization: "Personalization",
  availability: "Availability",
  utilization: "Provider utilization",
  exposureFairness: "Exposure fairness",
  model: "Model blend",
};

const fmtDetail = (inputs: Record<string, unknown>) =>
  Object.entries(inputs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(4) : v}`)
    .join(" · ");

/** "stage: note" lines from re-ranking, for the given stages. */
const notesFor = (c: CandidateDebug, stages: string[]) => (c.adjustmentsNotes ?? []).filter((n) => stages.some((s) => n.startsWith(`${s}:`)));

function Params({ rows }: { rows: [string, string | number | null | undefined][] }) {
  return (
    <table className="w-full text-left">
      <thead className="text-zinc-500">
        <tr>
          <th className="py-1">Parameter</th>
          <th className="py-1">Value</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {rows
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => (
            <tr key={k} className="border-t border-zinc-200 align-top">
              <td className="py-1 pr-3 font-sans text-zinc-500">{k}</td>
              <td className="py-1 text-zinc-800">{v === null ? "—" : typeof v === "number" ? +v.toFixed(4) : v}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="mt-1 list-disc pl-4 text-zinc-600">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

/** One layer's block: position/score after the layer, the layer's run status, and its parameters. */
function LayerSection({ c, k, layer, children }: { c: CandidateDebug; k: PipelineLayerKey; layer?: LayerMeta; children: ReactNode }) {
  const pos = c.layers?.[k];
  const i = LAYER_ORDER.indexOf(k);
  const prev = i > 1 ? c.layers?.[LAYER_ORDER[i - 1]] : undefined;
  const moved = pos && prev ? prev.rank - pos.rank : 0;
  return (
    <div className="rounded border border-zinc-200 bg-white p-2">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-zinc-800">
          Layer {i + 1} — {LAYER_TITLE[k]}
        </span>
        <span className="font-mono text-zinc-600">
          {pos ? (k === "eligibility" ? "passed" : `#${pos.rank}${pos.score !== null ? ` · ${layer?.scoreLabel ?? "score"} ${f3(pos.score)}` : ""}`) : "—"}
          {moved !== 0 && <span className={moved > 0 ? "ml-1 text-green-700" : "ml-1 text-red-500"}>{moved > 0 ? `▲${moved}` : `▼${-moved}`}</span>}
        </span>
      </div>
      {layer && (
        <p className="mb-1 text-zinc-500">
          <span className={layer.status === "fallback" ? "text-amber-700" : layer.status === "applied" ? "text-emerald-700" : ""}>{layer.status}</span>
          {layer.note && ` · ${layer.note}`}
          {layer.details && <span className="block font-mono text-[11px] text-zinc-400">{fmtDetail(layer.details)}</span>}
        </p>
      )}
      {children}
    </div>
  );
}

function Body({ c, layers }: { c: CandidateDebug; layers?: LayerMeta[] }) {
  const b = c.breakdown!;
  const a = c.astrologer;
  const layer = (k: PipelineLayerKey) => layers?.find((l) => l.key === k);
  const diversity = b.scores.find((s) => s.name === "diversityScore");
  const t = c.thompson;
  return (
      <div className="mt-2 space-y-3 rounded-lg bg-zinc-50 p-3 [&_table]:border-collapse [&_table]:bg-white [&_td]:border [&_td]:border-zinc-300 [&_td]:px-2 [&_th]:border [&_th]:border-zinc-300 [&_th]:bg-zinc-100 [&_th]:px-2">
        {c.layers && (
          <table className="w-full text-left">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1">Layer</th>
                <th className="py-1">Status</th>
                <th className="py-1 text-right">Position</th>
                <th className="py-1 text-right">Score</th>
                <th className="py-1 text-right">Move</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {LAYER_ORDER.map((k, i) => {
                const pos = c.layers?.[k];
                const prev = i > 1 ? c.layers?.[LAYER_ORDER[i - 1]] : undefined;
                const moved = pos && prev ? prev.rank - pos.rank : 0;
                return (
                  <tr key={k} className="border-t border-zinc-200 align-top">
                    <td className="py-1 font-sans">
                      L{i + 1} — {LAYER_TITLE[k]}
                    </td>
                    <td className="py-1 font-sans text-zinc-600">{layer(k)?.status ?? "—"}</td>
                    <td className="py-1 text-right">{k === "eligibility" ? (pos ? "✓" : "—") : pos ? `#${pos.rank}` : "—"}</td>
                    <td className="py-1 text-right">{pos && pos.score !== null && k !== "eligibility" ? f3(pos.score) : "—"}</td>
                    <td className={`py-1 text-right ${moved > 0 ? "text-green-700" : moved < 0 ? "text-red-500" : "text-zinc-400"}`}>
                      {moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <LayerSection c={c} k="eligibility" layer={layer("eligibility")}>
          <Params
            rows={[
              ["provider", c.providerId],
              ["price ₹/min", a?.pricePerMinute],
              ["online", a ? (a.isOnline ? "yes" : "no") : undefined],
              ["rating", a?.rating ?? null],
              ["reviews", a?.reviewCount],
              ["experience (yrs)", a?.experienceYears ?? null],
              ["languages", a?.languages.join(", ") || null],
              ["categories", a?.categories.join(", ") || null],
              ["specializations", a?.specializations.join(", ") || null],
              ["modes", a?.consultationModes.join(", ") || null],
            ]}
          />
        </LayerSection>

        <LayerSection c={c} k="business" layer={layer("business")}>
        <p className="font-mono text-zinc-800">{b.formula}</p>
        <Params
          rows={[
            ["baseScore", b.baseScore],
            ["finalScore", b.finalScore],
            ["totalScore", b.totalScore],
            ["model blend", b.model ? `${b.model.name} ${f3(b.model.prediction)} × ${b.model.weight}` : undefined],
          ]}
        />
        <p className="text-zinc-500">
          {b.segment} weights · utilizationScore {b.signals.utilizationScore === null ? "—" : f2(b.signals.utilizationScore)} · quotaUrgencyScore{" "}
          {f2(b.signals.quotaUrgencyScore)} · #{c.scoreRank} by score alone{c.isExploration ? " · exploration slot" : ""}
        </p>

        <table className="w-full text-left">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1">Score / component</th>
              <th className="py-1 text-right">Value</th>
              <th className="py-1 text-right">Weight</th>
              <th className="py-1 text-right">Contribution</th>
              <th className="py-1">Reason</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {[...b.scores]
              .sort((x, y) => y.contribution - x.contribution)
              .map((s) => (
                <Fragment key={s.name}>
                  <tr className="border-t border-zinc-300 align-top font-medium">
                    <td className="py-1 font-sans">{s.name}</td>
                    <td className="py-1 text-right">{f3(s.value)}</td>
                    <td className="py-1 text-right">{s.weight}</td>
                    <td className="py-1 text-right">{f3(s.contribution)}</td>
                    <td className="py-1 font-sans font-normal text-zinc-400">{s.missing ? "No data — neutral value used" : ""}</td>
                  </tr>
                  {s.components.map((cp) => (
                    <tr key={`${s.name}-${cp.name}`} className={`border-t border-zinc-100 align-top ${cp.value === null ? "text-zinc-400" : ""}`}>
                      <td className="py-0.5 font-sans">
                        <span className="pl-3">{cp.name}</span>
                      </td>
                      <td className="py-0.5 text-right">{cp.value === null ? "n/a" : f2(cp.value)}</td>
                      <td className="py-0.5 text-right text-zinc-400">w{cp.weight}</td>
                      <td className="py-0.5 text-right" />
                      <td className="py-0.5 font-sans text-zinc-500">{cp.reason ?? ""}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
          </tbody>
        </table>

        <table className="w-full text-left">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1">Adjustment</th>
              <th className="py-1 text-right">Applied</th>
              <th className="py-1 text-right">Raw</th>
              <th className="py-1 text-right">Bounds</th>
              <th className="py-1">Note / inputs</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {b.adjustments.map((a) => (
              <tr key={a.name} className="border-t border-zinc-200 align-top">
                <td className="py-1 font-sans">{a.name}</td>
                <td className="py-1 text-right">{f3(a.value)}</td>
                <td className="py-1 text-right">{f3(a.raw)}</td>
                <td className="py-1 text-right">[{a.bounds.join(", ")}]</td>
                <td className="py-1 font-sans text-zinc-600">
                  {a.note && <div>{a.note}</div>}
                  <div className="text-zinc-400">
                    {Object.entries(a.inputs)
                      .filter(([, v]) => v !== null && v !== undefined)
                      .map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(3) : v}`)
                      .join(" · ")}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {b.extension && (
          <table className="w-full text-left">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1">Extension term</th>
                <th className="py-1 text-right">Value</th>
                <th className="py-1 text-right">Weight</th>
                <th className="py-1 text-right">Contribution</th>
                <th className="py-1">Note / inputs</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {b.extension.terms.map((x) => (
                <tr key={x.name} className="border-t border-zinc-200 align-top">
                  <td className="py-1 font-sans">
                    {x.name} <span className="text-zinc-400">({x.kind})</span>
                  </td>
                  <td className="py-1 text-right">{x.value === null ? "n/a" : f3(x.value)}</td>
                  <td className="py-1 text-right">{x.weight}</td>
                  <td className={`py-1 text-right ${x.contribution < 0 ? "text-red-600" : ""}`}>{f3(x.contribution)}</td>
                  <td className="py-1 font-sans text-zinc-600">
                    {x.note && <div>{x.note}</div>}
                    <div className="text-zinc-400">{fmtDetail(x.inputs)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {b.pillars && (
          <div>
            <p className="mb-1 font-medium text-zinc-700">Business pillars (Σ = totalScore {f3(b.totalScore)})</p>
            <table className="w-full text-left">
              <tbody className="font-mono">
                {(Object.keys(PILLAR_LABEL) as BusinessPillarName[]).map((p) => {
                  const x = b.pillars![p];
                  return (
                    <tr key={p} className="border-t border-zinc-200 align-top">
                      <td className="py-1 font-sans">{PILLAR_LABEL[p]}</td>
                      <td className="py-1 text-right">{x.value === null ? "—" : f3(x.value)}</td>
                      <td className={`py-1 text-right ${x.contribution < 0 ? "text-red-600" : ""}`}>{x.contribution.toFixed(4)}</td>
                      <td className="py-1 pl-2 font-sans text-zinc-400">{x.sources.join(", ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        </LayerSection>

        <LayerSection c={c} k="candidates" layer={layer("candidates")}>
          <Params
            rows={[
              ["position by score alone", c.scoreRank !== undefined ? `#${c.scoreRank}` : undefined],
              ["diversityScore", diversity ? `${f3(diversity.value)} × ${diversity.weight} = ${f3(diversity.contribution)}` : undefined],
              ["novelty inputs", diversity?.components[0]?.detail ? fmtDetail(diversity.components[0].detail) : undefined],
              ["score with diversity", c.finalScore],
            ]}
          />
          <Notes notes={notesFor(c, ["diversity", "guardrail"])} />
        </LayerSection>

        <LayerSection c={c} k="ml" layer={layer("ml")}>
          {c.ml ? (
            <Params
              rows={[
                ["model", c.ml.model],
                ["model score (margin)", c.ml.score],
                ["rescaled to score range", c.ml.rescaled],
                ["orderScore (blend)", c.ml.orderScore],
              ]}
            />
          ) : (
            <p className="text-zinc-400">Not scored by a model — order kept from Layer 3.</p>
          )}
          <Notes notes={notesFor(c, ["ml"])} />
        </LayerSection>

        <LayerSection c={c} k="exploration" layer={layer("exploration")}>
          <Params
            rows={[
              ["exploration slot", c.isExploration ? "yes" : "no"],
              ["pre-bandit position", t ? `#${t.layer2Rank}` : c.layer2Rank !== undefined ? `#${c.layer2Rank}` : undefined],
              ["θ sample", t?.sample],
              ["posterior mean", t?.posteriorMean],
              ["prior mean", t?.priorMean],
              ["exposures (weighted)", t?.trials],
              ["completed consultations", t?.successes],
              ["fairness multiplier", t?.fairness],
              ["reward", t?.reward],
              ["mode / variant", t ? `${t.mode} / ${t.variant}` : undefined],
            ]}
          />
          {!t && <p className="text-zinc-400">Not a Thompson-sampling pick (picks are only shown at #3–#4).</p>}
          <Notes notes={notesFor(c, ["exploration", "bandit"])} />
        </LayerSection>

        <LayerSection c={c} k="final" layer={layer("final")}>
          <Params rows={[["served position", c.rank !== undefined ? `#${c.rank}` : undefined], ["score", c.finalScore]]} />
          <Notes notes={notesFor(c, ["final"])} />
          {notesFor(c, ["final"]).length === 0 && <p className="text-zinc-400">Passed revalidation, dedupe and constraint checks unchanged.</p>}
        </LayerSection>
      </div>
  );
}

export default function WhyDetails({ c, layers }: { c: CandidateDebug; layers?: LayerMeta[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="text-xs" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none text-indigo-700">Why #{c.rank}?</summary>
      {open && <Body c={c} layers={layers} />}
    </details>
  );
}
