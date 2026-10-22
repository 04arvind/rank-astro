"use client";

import { useEffect, useState } from "react";
import AstrologerCard from "@/components/astrologer/AstrologerCard";
import FilterBar, { type FilterOption, type FilterValue } from "@/components/astrologer/FilterBar";
import { identity } from "@/components/astrologer/identity";
import type { RankedAstrologer } from "@/types/ranking";

type RankResponse =
  | { success: true; data: RankedAstrologer[]; meta: { requestId: string; pagination?: { total: number } } }
  | { success: false; error: { code: string; message: string } };

interface State {
  items: RankedAstrologer[] | null;
  requestId?: string;
  loading: boolean;
  error: string | null;
}

type RowId = "premium" | "picks" | "all";

/** Fire-and-forget click event; survives navigation via sendBeacon. */
function trackClick(item: RankedAstrologer, placement: RowId, requestId?: string) {
  const { userId, sessionId } = identity();
  const body = JSON.stringify({
    events: [
      {
        type: "click",
        astrologerId: item.astrologer.id,
        providerId: item.astrologer.providerId,
        position: item.rank,
        placement,
        requestId,
        userId,
        sessionId,
      },
    ],
  });
  const blob = new Blob([body], { type: "application/json" });
  if (!navigator.sendBeacon?.("/api/analytics/events", blob)) {
    void fetch("/api/analytics/events", { method: "POST", body: blob, keepalive: true }).catch(() => {});
  }
}

function toQuery(f: FilterValue, limit: number): string {
  const { userId, sessionId } = identity();
  const q = new URLSearchParams({ userId, sessionId, limit: String(limit) });
  if (f.category) q.set("category", f.category);
  if (f.languages.length) q.set("languages", f.languages.join(","));
  if (f.minPrice !== undefined) q.set("minPrice", String(f.minPrice));
  if (f.maxPrice !== undefined) q.set("maxPrice", String(f.maxPrice));
  if (f.onlineOnly) q.set("onlineOnly", "true");
  return q.toString();
}

/** Positions of the ranked list each row shows (from config.ranking). */
export interface SlotLayout {
  /** Slots 1..premiumSlots: premium and top-ranked astrologers. */
  premiumSlots: number;
  /** Slots firstBanditSlot..lastBanditSlot: picked for you (Thompson sampling). */
  firstBanditSlot: number;
  lastBanditSlot: number;
  /** How many ranked astrologers to load. */
  limit: number;
}

interface AstrologerBrowserProps {
  categories: readonly FilterOption[];
  languages: readonly FilterOption[];
  layout: SlotLayout;
}

/**
 * An n×4 grid at every screen width (it scrolls sideways on narrow screens),
 * in final rank order: cells (0,0)–(0,1) are the premium slots, (0,2)–(0,3)
 * the Thompson-sampling picks, and every row after that the normal ranking.
 */
const GRID = "grid min-w-[56rem] auto-rows-fr grid-cols-4 gap-4";

/**
 * Every astrologer in final rank order. The top row is always 4 cells:
 * slots 1–2 (premium / top-ranked) at (0,0)–(0,1) and slots 3–4 (Thompson
 * sampling) at (0,2)–(0,3); from the second row on it is the normal ranking.
 */
export default function AstrologerBrowser({ categories, languages, layout }: AstrologerBrowserProps) {
  const [filters, setFilters] = useState<FilterValue>({ languages: [], onlineOnly: false });
  const [state, setState] = useState<State>({ items: null, loading: true, error: null });

  useEffect(() => {
    const controller = new AbortController();
    // Debounce so typing a price doesn't fire a request per keystroke.
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const res = await fetch(`/api/astrologer/rank?${toQuery(filters, layout.limit)}`, {
          signal: controller.signal,
        });
        const body = (await res.json()) as RankResponse;
        setState(
          body.success
            ? { items: body.data, requestId: body.meta.requestId, loading: false, error: null }
            : { items: null, loading: false, error: body.error.message },
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ items: null, loading: false, error: (err as Error).message });
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters, layout.limit]);

  const labelOf = (options: readonly FilterOption[], id: string) => options.find((o) => o.id === id)?.label ?? id;
  const consultContext = {
    topic: filters.category ? labelOf(categories, filters.category) : undefined,
    language: filters.languages.length ? filters.languages.map((l) => labelOf(languages, l)).join(", ") : undefined,
  };

  const items = state.items ?? [];
  const ordered = [...items].sort((a, b) => a.rank - b.rank);
  // Which reserved slot a 1-based rank is in, for click analytics.
  const rowOf = (rank: number): RowId =>
    rank <= layout.premiumSlots ? "premium" : rank >= layout.firstBanditSlot && rank <= layout.lastBanditSlot ? "picks" : "all";

  return (
    <div className="flex flex-col gap-6">
      <FilterBar value={filters} onChange={setFilters} categories={categories} languages={languages} />

      {state.error ? (
        <p className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{state.error}</p>
      ) : state.loading || !state.items ? (
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <div className={GRID} aria-busy="true">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-44 animate-pulse rounded-2xl bg-white/60" />
            ))}
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-lavender-300 bg-white/40 p-6 text-center text-sm text-celestial-800/60">
          No astrologers match your filters.
        </p>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <ol className={GRID}>
            {ordered.map((item) => (
              <li key={item.astrologer.id} className="h-full min-w-0">
                <AstrologerCard
                  item={item}
                  showRank={false}
                  showExplanation
                  onSelect={() => trackClick(item, rowOf(item.rank), state.requestId)}
                  consultContext={consultContext}
                />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
