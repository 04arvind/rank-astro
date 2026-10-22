import { config } from "@/config";
import type { ComponentExplanation } from "@/types/ranking";
import type { RankedCandidate, ScoredCandidate } from "./types";

const components = (c: Pick<ScoredCandidate, "explanation">): ComponentExplanation[] =>
  c.explanation.scores.flatMap((s) => s.components);

/** Finds a component (e.g. "repeatAstrologer") in a candidate's explanation. */
export function componentOf(c: Pick<ScoredCandidate, "explanation">, name: string): ComponentExplanation | undefined {
  return components(c).find((x) => x.name === name);
}

/**
 * Short, user-safe reasons: only user-audience components that scored well
 * and actually moved the score, strongest first. Priority components
 * (personal history) come first and skip the minimum-value bar. Business,
 * provider and penalty details never reach users.
 */
export function userReasons(c: RankedCandidate): string[] {
  const { maxUserReasons, minContribution, minSignalValue, priority } = config.ranking.explanation;
  const rank = (name: string) => {
    const i = (priority as readonly string[]).indexOf(name);
    return i < 0 ? priority.length : i;
  };
  const reasons = components(c)
    .filter(
      (x) =>
        x.audience === "user" &&
        x.reason &&
        x.value !== null &&
        x.contribution >= minContribution &&
        (x.value >= minSignalValue || rank(x.name) < priority.length),
    )
    .sort((a, b) => rank(a.name) - rank(b.name) || b.contribution - a.contribution)
    .map((x) => x.reason!);
  if (c.isExploration && !reasons.includes("New on the platform")) reasons.push("Recommended for you to discover");
  return [...new Set(reasons)].slice(0, maxUserReasons);
}

const f3 = (n: number) => n.toFixed(3);

/** Full, internal explanation of how a candidate got its rank. */
export function explainRank(c: RankedCandidate): string[] {
  const e = c.explanation;
  const lines = [`Rank #${c.rank} (#${c.scoreRank} by score alone) · ${e.segment} weights · scorer ${c.scorer}`, e.formula];
  for (const s of [...e.scores].sort((a, b) => b.contribution - a.contribution)) {
    const parts = s.components
      .filter((x) => x.value !== null)
      .map((x) => `${x.name} ${f3(x.value!)}${x.reason ? ` (${x.reason})` : ""}`)
      .join(", ");
    lines.push(`+${f3(s.contribution)} ${s.name} ${f3(s.value)} × ${s.weight}${s.missing ? " [no data → neutral]" : ""}${parts ? ` ← ${parts}` : ""}`);
  }
  for (const a of e.adjustments) {
    lines.push(`${a.value >= 0 ? "+" : "−"}${f3(Math.abs(a.value))} ${a.name} (raw ${f3(a.raw)}, bounds [${a.bounds.join(", ")}])${a.note ? ` — ${a.note}` : ""}`);
  }
  for (const t of e.extension?.terms ?? []) {
    lines.push(`${t.contribution >= 0 ? "+" : "−"}${f3(Math.abs(t.contribution))} ${t.name} ${t.value === null ? "n/a" : f3(t.value)} × ${t.weight}${t.note ? ` — ${t.note}` : ""}`);
  }
  for (const r of c.adjustments) lines.push(`${r.stage}: ${r.note}`);
  return lines;
}

/** Score and adjustment name → weighted contribution, for compact debug tables. */
export function contributionMap(c: Pick<ScoredCandidate, "explanation">): Record<string, number> {
  return {
    ...Object.fromEntries(c.explanation.scores.map((s) => [s.name, s.contribution])),
    ...Object.fromEntries(c.explanation.adjustments.map((a) => [a.name, a.value])),
    ...Object.fromEntries((c.explanation.extension?.terms ?? []).map((t) => [t.name, t.contribution])),
  };
}
