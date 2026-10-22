"use client";

import { useEffect, useState } from "react";
import { api, errorText, fmtDate, inr, type AdminAstrologerRow, type ProviderSummary } from "./api";
import { Alert, Badge, Button, Field, inputCls, Modal } from "./ui";

type Status = AdminAstrologerRow["status"];
const STATUSES: Status[] = ["online", "busy", "offline", "unknown"];
const STATUS_TONE = { online: "green", busy: "amber", offline: "zinc", unknown: "zinc" } as const;
const PAGE_SIZE = 25;

export interface AstrologerFilters {
  providerId: string;
  q: string;
  view: "live" | "hidden";
  status: "" | Status;
}

/** Browse, edit, hide/unhide and delete astrologers stored in MongoDB. */
export default function AstrologersPanel({
  providers,
  filters,
  onFilters,
  onChanged,
  version,
}: {
  providers: ProviderSummary[];
  filters: AstrologerFilters;
  onFilters: (f: AstrologerFilters) => void;
  onChanged: () => void;
  version: number;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ key: string; items: AdminAstrologerRow[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<AdminAstrologerRow | null>(null);
  const [q, setQ] = useState(filters.q);

  const params = new URLSearchParams({ view: filters.view, page: String(page), pageSize: String(PAGE_SIZE) });
  if (filters.providerId) params.set("providerId", filters.providerId);
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  const key = `${params}#${version}`;
  const loading = data?.key !== key;

  useEffect(() => {
    let live = true;
    api<{ items: AdminAstrologerRow[]; total: number }>(`/api/admin/astrologers?${key.split("#")[0]}`)
      .then((d) => {
        if (!live) return;
        setData({ key, ...d });
        setSelected(new Set());
        setError(null);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [key]);

  // Debounced search box.
  useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => {
      setPage(1);
      onFilters({ ...filters, q });
    }, 300);
    return () => clearTimeout(t);
  }, [q, filters, onFilters]);

  const setFilter = (patch: Partial<AstrologerFilters>) => {
    setPage(1);
    onFilters({ ...filters, ...patch });
  };

  async function bulk(action: "hide" | "unhide" | "delete", ids: string[]) {
    if (!ids.length) return;
    if (action === "delete" && !confirm(`Permanently delete ${ids.length} astrologer${ids.length === 1 ? "" : "s"} from the database?`)) return;
    try {
      await api("/api/admin/astrologers", { method: "POST", json: { action, ids } });
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const items = data?.items ?? [];
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const allSelected = items.length > 0 && items.every((a) => selected.has(a.id));
  const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <input className={`${inputCls} w-56`} placeholder="Search name or id…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={inputCls} value={filters.providerId} onChange={(e) => setFilter({ providerId: e.target.value })}>
          <option value="">All providers</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className={inputCls} value={filters.status} onChange={(e) => setFilter({ status: e.target.value as AstrologerFilters["status"] })}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded border border-zinc-300">
          {(["live", "hidden"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setFilter({ view: v })}
              className={`px-3 py-1.5 ${filters.view === v ? "bg-zinc-900 text-white" : "bg-white text-zinc-700 hover:bg-zinc-50"}`}
            >
              {v === "live" ? "Live" : "Hidden"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          {selected.size > 0 && (
            <>
              <span className="self-center text-xs text-zinc-500">{selected.size} selected</span>
              {filters.view === "live" ? (
                <Button size="sm" onClick={() => bulk("hide", [...selected])}>
                  Hide
                </Button>
              ) : (
                <Button size="sm" onClick={() => bulk("unhide", [...selected])}>
                  Restore
                </Button>
              )}
              <Button size="sm" variant="danger" onClick={() => bulk("delete", [...selected])}>
                Delete
              </Button>
            </>
          )}
          <a
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
            href={`/api/admin/astrologers/export${filters.providerId ? `?providerId=${encodeURIComponent(filters.providerId)}` : ""}`}
          >
            Export CSV
          </a>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      <div className="overflow-x-auto rounded-lg border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((a) => a.id)))}
                />
              </th>
              {["Astrologer", "Provider", "₹/min", "Rating", "Exp", "Languages", "Status", "Data", ""].map((h) => (
                <th key={h} className="px-2 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={loading ? "opacity-50" : ""}>
            {items.map((a) => (
              <tr key={a.id} className="border-t border-zinc-100 align-top hover:bg-zinc-50/60">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${a.name}`}
                    checked={selected.has(a.id)}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(a.id)) next.delete(a.id);
                      else next.add(a.id);
                      setSelected(next);
                    }}
                  />
                </td>
                <td className="px-2 py-2">
                  <div className="font-medium text-zinc-900">{a.name}</div>
                  <div className="text-[11px] text-zinc-400">{a.id}</div>
                </td>
                <td className="px-2 py-2 text-zinc-700">{nameOf(a.providerId)}</td>
                <td className="px-2 py-2">{inr(a.perMinute)}</td>
                <td className="px-2 py-2">
                  {a.rating ?? "—"}
                  {a.reviewCount > 0 && <span className="text-xs text-zinc-400"> ({a.reviewCount})</span>}
                </td>
                <td className="px-2 py-2">{a.experienceYears ?? "—"}</td>
                <td className="px-2 py-2 text-xs text-zinc-600">{a.languages.join(", ") || "—"}</td>
                <td className="px-2 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                    {a.verified ? <Badge tone="indigo">verified</Badge> : <Badge tone="amber">unverified</Badge>}
                    {a.tier && <Badge>{a.tier}</Badge>}
                    {a.archiveReason && <Badge tone="rose">{a.archiveReason === "hidden" ? "hidden" : "provider paused"}</Badge>}
                  </div>
                </td>
                <td className="px-2 py-2 text-xs text-zinc-500" title={[...a.missing.map((m) => `missing ${m}`), ...a.unmapped].join("\n")}>
                  {a.missing.length} missing{a.unmapped.length > 0 && `, ${a.unmapped.length} unmapped`}
                  <div className="text-[11px] text-zinc-400">{fmtDate(a.importedAt)}</div>
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                    Edit
                  </Button>
                  {a.hidden ? (
                    <Button size="sm" variant="ghost" onClick={() => bulk("unhide", [a.id])}>
                      Restore
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => bulk("hide", [a.id])}>
                      Hide
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-sm text-zinc-500">
                  {loading ? "Loading…" : filters.view === "hidden" ? "No hidden astrologers." : "No astrologers match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{data ? `${data.total.toLocaleString("en-IN")} astrologer${data.total === 1 ? "" : "s"}` : ""}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            Page {page} of {pages}
          </span>
          <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      </div>

      {editing && (
        <EditAstrologerDialog
          astrologer={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function EditAstrologerDialog({ astrologer: a, onClose, onSaved }: { astrologer: AdminAstrologerRow; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(a.name);
  const [perMinute, setPerMinute] = useState(String(a.perMinute));
  const [status, setStatus] = useState<Status>(a.status);
  const [verified, setVerified] = useState(a.verified);
  const [tier, setTier] = useState(a.tier ?? "");
  const [experience, setExperience] = useState(a.experienceYears === null ? "" : String(a.experienceYears));
  const [rating, setRating] = useState(a.rating === null ? "" : String(a.rating));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api("/api/admin/astrologers", {
        method: "PATCH",
        json: {
          id: a.id,
          changes: { name, perMinute: Number(perMinute), status, verified, tier: tier.trim() || null, experienceYears: num(experience), rating: num(rating) },
        },
      });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Edit ${a.name}`} onClose={onClose}>
      <form
        className="grid gap-3 p-5 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="sm:col-span-2">
          <Field label="Name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
          </Field>
        </div>
        <Field label="Price per minute (₹)">
          <input className={inputCls} type="number" min="0.01" step="0.01" value={perMinute} onChange={(e) => setPerMinute(e.target.value)} required />
        </Field>
        <Field label="Availability status" hint="Live provider availability may override this.">
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Experience (years)">
          <input className={inputCls} type="number" min="0" max="80" value={experience} onChange={(e) => setExperience(e.target.value)} />
        </Field>
        <Field label="Rating (0–5)">
          <input className={inputCls} type="number" min="0" max="5" step="0.1" value={rating} onChange={(e) => setRating(e.target.value)} />
        </Field>
        <Field label="Tier">
          <input className={inputCls} value={tier} onChange={(e) => setTier(e.target.value)} maxLength={20} placeholder="e.g. T1" />
        </Field>
        <label className="flex items-center gap-2 pt-6 text-sm">
          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
          Verified
        </label>
        {error && (
          <div className="sm:col-span-2">
            <Alert>{error}</Alert>
          </div>
        )}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
