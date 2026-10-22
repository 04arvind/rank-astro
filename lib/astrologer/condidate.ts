import { config } from "@/config";
import type { AstrologerMetrics } from "@/types/analytics";
import type { AstrologerProfile } from "@/types/astrologer";
import type { RankingContext } from "@/types/ranking";
import { checkEligibility, type ExclusionReason } from "./eligibility";
import { getAstrologerRepository, type AstrologerRepository } from "./repository";

export interface ExcludedCandidate {
  astrologer: AstrologerProfile;
  reasons: ExclusionReason[];
}

export interface CandidateSet {
  candidates: AstrologerProfile[];
  excluded: ExcludedCandidate[];
  /** Eligible astrologers dropped by the maxCandidates cap. */
  truncated: number;
  /** Which ones (empty when nothing was cut). */
  truncatedIds?: string[];
}

export interface CandidateOptions {
  repository?: AstrologerRepository;
  metrics?: ReadonlyMap<string, AstrologerMetrics>;
  /** Restrict to specific astrologers (debug tooling). */
  astrologerIds?: readonly string[];
  now?: number;
}

/** How many of the request's soft preferences a profile matches. Retrieval only — not a score. */
function preferenceMatches(a: AstrologerProfile, ctx: RankingContext): number {
  const { category, languages } = ctx.context;
  let n = 0;
  if (category && a.categories.includes(category)) n++;
  if (languages?.some((l) => a.languages.includes(l))) n++;
  return n;
}

/**
 * Candidate generation: load → eligibility → cap. When more astrologers are
 * eligible than config.ranking.pagination.maxCandidates, those matching the
 * request's language/category are retained first (then stable id order) so
 * relevant astrologers aren't cut before scoring. Ordering here is not the
 * final ranking.
 */
export async function generateCandidates(
  ctx: RankingContext,
  { repository = getAstrologerRepository(), metrics, astrologerIds, now = Date.now() }: CandidateOptions = {},
): Promise<CandidateSet> {
  const pool = astrologerIds ? await repository.getByIds(astrologerIds) : await repository.list();

  const eligible: AstrologerProfile[] = [];
  const excluded: ExcludedCandidate[] = [];
  for (const a of pool) {
    const result = checkEligibility(a, { ctx, metrics: metrics?.get(a.id), now });
    if (result.eligible) eligible.push(a);
    else excluded.push({ astrologer: a, reasons: result.reasons });
  }

  const { maxCandidates } = config.ranking.pagination;
  if (eligible.length <= maxCandidates) return { candidates: eligible, excluded, truncated: 0 };

  const ordered = eligible
    .map((a) => ({ a, m: preferenceMatches(a, ctx) }))
    .sort((x, y) => y.m - x.m || x.a.id.localeCompare(y.a.id))
    .map((x) => x.a);
  const retained = ordered.slice(0, maxCandidates);

  return { candidates: retained, excluded, truncated: eligible.length - maxCandidates, truncatedIds: ordered.slice(maxCandidates).map((a) => a.id) };
}
