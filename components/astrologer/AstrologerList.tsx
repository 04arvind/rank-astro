import type { RankedAstrologer } from "@/types/ranking";
import AstrologerCard from "./AstrologerCard";

interface AstrologerListProps {
  /** Already ordered by the ranking API; rendered as-is. */
  items: RankedAstrologer[];
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  showRank?: boolean;
  showExplanation?: boolean;
  onSelect?: (astrologerId: string) => void;
}

export default function AstrologerList({
  items,
  loading = false,
  error = null,
  emptyMessage = "No astrologers match your filters.",
  showRank,
  showExplanation,
  onSelect,
}: AstrologerListProps) {
  if (error) {
    return <p className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>;
  }

  if (loading) {
    return (
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="h-40 animate-pulse rounded-xl bg-zinc-100" />
        ))}
      </ul>
    );
  }

  if (items.length === 0) {
    return <p className="p-8 text-center text-sm text-zinc-500">{emptyMessage}</p>;
  }

  return (
    <ol className="grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li key={item.astrologer.id} className="h-full">
          <AstrologerCard
            item={item}
            showRank={showRank}
            showExplanation={showExplanation}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ol>
  );
}
