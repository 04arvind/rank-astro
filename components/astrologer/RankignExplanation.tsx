interface RankingExplanationProps {
  reasons?: string[];
  className?: string;
}

/** Renders the engine-provided reasons for an astrologer's position. */
export default function RankingExplanation({ reasons, className = "" }: RankingExplanationProps) {
  if (!reasons?.length) return null;

  return (
    <div className={`rounded-xl border border-lavender-200/70 bg-gradient-to-br from-lavender-50/90 to-ivory-50/90 px-3 py-2 text-xs text-celestial-800 ${className}`}>
      <p className="mb-1 font-medium text-celestial-700">Why you&apos;re seeing this</p>
      <ul className="list-disc space-y-0.5 pl-4 marker:text-gold-400">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}
