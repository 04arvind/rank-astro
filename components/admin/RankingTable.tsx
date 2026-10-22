import type { EngineInfo, RankedAstrologer } from "@/types/ranking";

interface RankingTableProps {
  items: RankedAstrologer[];
  engine?: EngineInfo;
}

export default function RankingTable({ items, engine }: RankingTableProps) {
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 className="font-semibold">Ranked astrologers</h2>
        {engine && (
          <span className="text-xs text-zinc-500">
            {engine.name} v{engine.version}
          </span>
        )}
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-2">#</th>
              <th className="px-4 py-2">Astrologer</th>
              <th className="px-4 py-2">Provider</th>
              <th className="px-4 py-2 text-right">Score</th>
              <th className="px-4 py-2 text-right">Rating</th>
              <th className="px-4 py-2 text-right">₹/min</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Reasons</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {items.map(({ rank, score, astrologer: a, reasons }) => (
              <tr key={a.id} className="hover:bg-zinc-50">
                <td className="px-4 py-2 font-mono text-zinc-500">{rank}</td>
                <td className="px-4 py-2">
                  <div className="font-medium">{a.name}</div>
                  <div className="font-mono text-xs text-zinc-400">{a.id}</div>
                </td>
                <td className="px-4 py-2">{a.providerId}</td>
                <td className="px-4 py-2 text-right font-mono">{score.toFixed(4)}</td>
                <td className="px-4 py-2 text-right">{a.rating?.toFixed(1) ?? "—"}</td>
                <td className="px-4 py-2 text-right">{a.pricePerMinute}</td>
                <td className="px-4 py-2">
                  <span className={a.isOnline ? "text-green-600" : "text-zinc-400"}>
                    {a.isOnline ? "Online" : "Offline"}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-zinc-600">{reasons?.join("; ") ?? "—"}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                  No results
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
