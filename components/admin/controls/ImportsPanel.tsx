"use client";

import { useEffect, useState } from "react";
import { RejectedList } from "./AddAstrologersDialog";
import { api, errorText, fmtDate, type ImportRecordDoc } from "./api";
import { Alert, Badge } from "./ui";

/** Every import with its source, outcome counts and rejected rows. */
export default function ImportsPanel({ version }: { version: number }) {
  const [rows, setRows] = useState<ImportRecordDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<ImportRecordDoc[]>("/api/admin/imports?limit=50")
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [version]);

  if (error) return <Alert>{error}</Alert>;
  if (!rows) return <p className="py-6 text-center text-sm text-zinc-500">Loading…</p>;
  if (!rows.length) return <p className="py-6 text-center text-sm text-zinc-500">No imports yet — use “Add astrologers” to import a list.</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
          <tr>
            {["When", "Provider", "Source", "Mode", "Rows", "Valid", "New", "Updated", "Removed", "Rejected"].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r._id} className="border-t border-zinc-100 align-top">
              <td className="whitespace-nowrap px-3 py-2 text-zinc-600">{fmtDate(r.at)}</td>
              <td className="px-3 py-2 font-medium text-zinc-900">{r.providerName}</td>
              <td className="max-w-64 px-3 py-2 text-xs">
                <Badge tone="indigo">{r.format}</Badge>{" "}
                {r.source.kind === "link" && r.source.url ? (
                  <a href={r.source.url} target="_blank" rel="noreferrer noopener" className="break-all text-indigo-700 hover:underline">
                    {r.source.fileName ?? r.source.url}
                  </a>
                ) : (
                  <span className="text-zinc-600">{r.source.fileName ?? "upload"}</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs">{r.mode === "replace" ? "replace" : "add / update"}</td>
              <td className="px-3 py-2">{r.rows}</td>
              <td className="px-3 py-2 text-emerald-700">{r.accepted}</td>
              <td className="px-3 py-2">{r.inserted}</td>
              <td className="px-3 py-2">{r.updated}</td>
              <td className="px-3 py-2">{r.removed}</td>
              <td className="px-3 py-2">{r.rejected > 0 ? <RejectedList rows={r.rejectedSample} total={r.rejected} /> : <span className="text-zinc-400">0</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
