import type { FeedColumn as FeedColumnData, FeedItem } from "@/types/feed";
import AstrologerCard from "./AstrologerCard";

/**
 * Fixed-size column shell: header stays put, the list below scrolls on its
 * own. 780px leaves roughly 650–690px of scrollable list under the header.
 */
const SHELL =
  "flex h-[780px] min-w-0 flex-col rounded-3xl border border-white/50 bg-ivory-50/35 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] backdrop-blur-sm";
const SCROLL_AREA =
  "-mx-1 mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1 pt-1 [scrollbar-color:var(--color-lavender-300)_transparent] [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-celestial-400";

interface FeedColumnProps {
  column: FeedColumnData;
  /** Whether any column has results — decides between "no matches" and "no more matches". */
  anyResults?: boolean;
  onSelect?: (item: FeedItem) => void;
  /** Topic / language the user is browsing by, passed on with a booking. */
  consultContext?: { topic?: string; language?: string };
}

/** One home-page column: heading, then its astrologers; "similar" picks sit under their own divider. */
export default function FeedColumn({ column, anyResults = false, onSelect, consultContext }: FeedColumnProps) {
  const firstRelated = column.items.findIndex((i) => i.related);
  const headingId = `feed-${column.id}`;

  return (
    <section aria-labelledby={headingId} className={SHELL}>
      <header className="shrink-0 px-1 pt-1">
        <h2 id={headingId} className="flex items-center gap-2 font-display text-2xl font-semibold text-celestial-900">
          <span aria-hidden="true" className="text-base text-gold-400">✦</span>
          {column.title}
        </h2>
        <p className="mt-0.5 text-sm text-celestial-800/65">{column.subtitle}</p>
        <div aria-hidden="true" className="mt-2 h-px bg-gradient-to-r from-gold-300/80 via-lavender-300/60 to-transparent" />
      </header>

      {/* Focusable so keyboard users can scroll it. */}
      <div className={SCROLL_AREA} tabIndex={0} role="region" aria-labelledby={headingId}>
        {column.items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-lavender-300 bg-white/40 p-6 text-center text-sm text-celestial-800/60">
            {anyResults ? "No more astrologers match your filters — see the other columns." : "No astrologers match your filters."}
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {column.items.map((item, i) => (
              <li key={item.astrologer.id}>
                {i === firstRelated && (
                  <p className="mb-2 mt-1 flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.2em] text-celestial-500">
                    <span aria-hidden="true" className="h-px flex-1 bg-lavender-300" />
                    Similar astrologers
                    <span aria-hidden="true" className="h-px flex-1 bg-lavender-300" />
                  </p>
                )}
                <AstrologerCard
                  item={item}
                  showRank={false}
                  showExplanation
                  highlight={item.highlight}
                  onSelect={onSelect ? () => onSelect(item) : undefined}
                  consultContext={consultContext}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export function FeedColumnSkeleton() {
  return (
    <div className={`${SHELL} gap-3 overflow-hidden`} aria-hidden="true">
      <div className="h-7 w-40 shrink-0 animate-pulse rounded-lg bg-lavender-100/80" />
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="h-40 shrink-0 animate-pulse rounded-2xl bg-white/60" />
      ))}
    </div>
  );
}
