"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AddAstrologersDialog from "./AddAstrologersDialog";
import { api, errorText, fmtDate, inr, type DatabaseOverview, type ProviderSummary } from "./api";
import AstrologersPanel, { type AstrologerFilters } from "./AstrologersPanel";
import ImportsPanel from "./ImportsPanel";
import { Alert, Badge, Button } from "./ui";

type Tab = "providers" | "astrologers" | "imports";

/**
 * Admin controls on the ranking dashboard: add astrologer lists, manage
 * providers and individual astrologers, and review import history. Every
 * change goes straight to MongoDB; the ranking panels below pick it up on
 * refresh (the astrologer cache lasts a few seconds).
 */
export default function AdminControls() {
  const router = useRouter();
  const [overview, setOverview] = useState<DatabaseOverview | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("providers");
  const [adding, setAdding] = useState<{ provider: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [filters, setFilters] = useState<AstrologerFilters>({ providerId: "", q: "", view: "live", status: "" });

  useEffect(() => {
    let live = true;
    api<{ overview: DatabaseOverview; providers: ProviderSummary[] }>("/api/admin/providers")
      .then((d) => {
        if (!live) return;
        setOverview(d.overview);
        setProviders(d.providers.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name)));
        setError(null);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [version]);

  /** Reload admin data and the server-rendered ranking panels. */
  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    // Give the astrologer cache (5s) a moment before re-rendering the ranking.
    setTimeout(() => router.refresh(), 5500);
  }, [router]);

  async function providerAction(action: "pause" | "resume" | "delete" | "resync" | "syncFeeds", p?: ProviderSummary) {
    const confirmText = {
      pause: `Pause ${p?.name}? All its astrologers are taken off the list until you resume.`,
      delete: `Delete all astrologers of ${p?.name}${p?.addedByAdmin ? " and the provider" : ""} from the database? This can't be undone.`,
      syncFeeds:
        "Re-import the built-in provider feeds from data/csv? Astrologers added from the dashboard under a built-in provider that aren't in its feed will be removed. Hidden astrologers stay hidden.",
    } as Partial<Record<typeof action, string>>;
    if (confirmText[action] && !confirm(confirmText[action])) return;

    setBusy(`${action}:${p?.id ?? ""}`);
    setNotice(null);
    try {
      const r = await api<Record<string, unknown>>("/api/admin/providers", { method: "POST", json: { action, providerId: p?.id } });
      const rec = r.record as { accepted: number; inserted: number; updated: number; removed: number } | undefined;
      setNotice(
        action === "pause" ? `Paused ${p?.name}: ${r.moved} astrologers hidden.`
        : action === "resume" ? `Resumed ${p?.name}: ${r.moved} astrologers back live.`
        : action === "delete" ? `Deleted ${r.removed} astrologers of ${p?.name}.`
        : action === "resync" && rec ? `Re-synced ${p?.name}: ${rec.accepted} valid · ${rec.inserted} new · ${rec.updated} updated · ${rec.removed} removed.`
        : `Built-in feeds synced: ${r.inserted} new · ${r.updated} updated · ${r.removed} removed · ${r.rejected} rejected rows.`,
      );
      changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const stats: [string, string | number][] = overview
    ? [
        ["Live astrologers", overview.live.toLocaleString("en-IN")],
        ["Hidden", overview.hidden],
        ["Providers", overview.providers],
        ["Imports", overview.imports],
        ["Last import", fmtDate(overview.lastImportAt)],
      ]
    : [];

  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-3">
        <div className="mr-auto">
          <h2 className="font-semibold">Admin controls</h2>
          <p className="text-xs text-zinc-500">
            {overview ? (
              <>
                MongoDB <code>{overview.database}</code> · {overview.pingMs} ms
              </>
            ) : error ? (
              "Database unavailable"
            ) : (
              "Connecting…"
            )}
          </p>
        </div>
        <Button onClick={() => providerAction("syncFeeds")} disabled={busy !== null || !overview}>
          {busy === "syncFeeds:" ? "Syncing…" : "Sync built-in feeds"}
        </Button>
        <Button variant="primary" onClick={() => setAdding({ provider: "" })} disabled={!overview}>
          + Add astrologers
        </Button>
      </header>

      {stats.length > 0 && (
        <dl className="grid grid-cols-2 gap-px border-b border-zinc-200 bg-zinc-200 sm:grid-cols-5">
          {stats.map(([k, v]) => (
            <div key={k} className="bg-white px-4 py-2">
              <dt className="text-xs text-zinc-500">{k}</dt>
              <dd className="text-sm font-semibold text-zinc-900">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex flex-col gap-3 p-4">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="green">{notice}</Alert>}

        <nav className="flex gap-1 border-b border-zinc-200 text-sm">
          {(
            [
              ["providers", "Providers"],
              ["astrologers", "Astrologers"],
              ["imports", "Import history"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 py-2 ${tab === k ? "border-zinc-900 font-medium text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "providers" && (
          <div className="overflow-x-auto rounded-lg border border-zinc-200">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
                <tr>
                  {["Provider", "Live", "Online", "Hidden", "Avg ₹/min", "Source", "Last import", ""].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => {
                  const working = busy?.endsWith(`:${p.id}`);
                  return (
                    <tr key={p.id} className="border-t border-zinc-100 align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium text-zinc-900">{p.name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1">
                          <code className="text-[11px] text-zinc-400">{p.id}</code>
                          {p.configured ? <Badge>built-in</Badge> : <Badge tone="indigo">added by admin</Badge>}
                          {p.paused && <Badge tone="rose">paused</Badge>}
                          {!p.rankable && (
                            <Badge tone="amber" title="Add this provider to config/provider.config.ts (enabled, with a target share) for its astrologers to be ranked.">
                              not ranked
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-medium">{p.live}</td>
                      <td className="px-3 py-2">{p.online}</td>
                      <td className="px-3 py-2">{p.hidden}</td>
                      <td className="px-3 py-2">{inr(p.avgPrice)}</td>
                      <td className="max-w-48 px-3 py-2 text-xs">
                        {p.source?.kind === "link" && p.source.url ? (
                          <a href={p.source.url} target="_blank" rel="noreferrer noopener" className="break-all text-indigo-700 hover:underline">
                            {p.source.fileName ?? "link"}
                          </a>
                        ) : p.source?.kind === "upload" ? (
                          <span className="text-zinc-600">{p.source.fileName ?? "uploaded file"}</span>
                        ) : (
                          <span className="text-zinc-400">{p.configured ? "data/csv feed" : "—"}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-600">{fmtDate(p.lastImportAt)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setAdding({ provider: p.name })}>
                            Add list
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setFilters({ providerId: p.id, q: "", view: "live", status: "" });
                              setTab("astrologers");
                            }}
                          >
                            View
                          </Button>
                          {p.source?.kind === "link" && (
                            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => providerAction("resync", p)}>
                              {working && busy?.startsWith("resync") ? "Syncing…" : "Re-sync"}
                            </Button>
                          )}
                          {p.paused ? (
                            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => providerAction("resume", p)}>
                              Resume
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" disabled={busy !== null || p.live === 0} onClick={() => providerAction("pause", p)}>
                              Pause
                            </Button>
                          )}
                          <Button size="sm" variant="danger" disabled={busy !== null || p.live + p.hidden === 0} onClick={() => providerAction("delete", p)}>
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!providers.length && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-sm text-zinc-500">
                      {overview ? "No providers yet." : "Loading…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "astrologers" && <AstrologersPanel providers={providers} filters={filters} onFilters={setFilters} onChanged={changed} version={version} />}
        {tab === "imports" && <ImportsPanel version={version} />}
      </div>

      {adding && (
        <AddAstrologersDialog
          providers={providers}
          initialProvider={adding.provider}
          onClose={() => setAdding(null)}
          onImported={(r) => {
            setNotice(`Imported ${r.record.accepted} astrologers for ${r.record.providerName}.`);
            changed();
          }}
        />
      )}
    </section>
  );
}
