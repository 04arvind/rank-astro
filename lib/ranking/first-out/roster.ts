import { canTake, listEligibleAstrologers, type DurationMinutes } from "@/lib/consultation/offers";
import { listProviders } from "@/lib/providers";
import type { AstrologerProfile } from "@/types/astrologer";

/*
 * The First-Out roster: one "sheet" per enabled provider (config order,
 * i.e. the provider feeds in data/csv), each listing its astrologers in the
 * feed's row order. Round-robin positions index into these lists, so they
 * stay stable while the feed files don't change.
 */

export interface Sheet {
  providerId: string;
  astrologers: AstrologerProfile[];
}

/** Feed row number from `source.ref` ("row:12"); rows without one sort last. */
function rowOf(a: AstrologerProfile): number {
  const n = Number(/^row:(\d+)$/.exec(a.source.ref ?? "")?.[1]);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

const byRow = (x: AstrologerProfile, y: AstrologerProfile) => rowOf(x) - rowOf(y) || x.id.localeCompare(y.id);

/** Every enabled provider's sheet, including empty ones, so sheet positions never shift. */
export function buildSheets(astrologers: readonly AstrologerProfile[]): Sheet[] {
  return listProviders({ enabledOnly: true }).map((p) => ({
    providerId: p.id,
    astrologers: astrologers.filter((a) => a.providerId === p.id).sort(byRow),
  }));
}

/**
 * Who can take a First-Out call of this length: eligible on the platform,
 * audio, minimum call time fits. Not narrowed to the card's cheapest price,
 * so every sheet takes its turn.
 */
export async function getFirstOutPool(minutes: DurationMinutes, now = Date.now()): Promise<AstrologerProfile[]> {
  const eligible = (await listEligibleAstrologers(now)).filter((a) => canTake(a, minutes));
  return buildSheets(eligible).flatMap((s) => s.astrologers);
}
