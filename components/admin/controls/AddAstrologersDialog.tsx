"use client";

import { useState } from "react";
import { IMPORT_FIELDS, type ColumnMapping } from "@/lib/admin/fields";
import { api, ApiFailure, errorText, inr, type ImportPreview, type ImportResult, type ProviderSummary } from "./api";
import { Alert, Badge, Button, Field, inputCls, Modal } from "./ui";

type SourceKind = "link" | "upload";
type Mode = "merge" | "replace";

const FORMAT_LABEL = { xlsx: "Excel", csv: "CSV / Google Sheet", json: "JSON", pdf: "PDF" } as const;

/**
 * "Add astrologers" card: provider name + list link (Google Sheet, Excel,
 * CSV, PDF…) or an uploaded file → preview with editable column mapping →
 * import into MongoDB.
 */
export default function AddAstrologersDialog({
  providers,
  initialProvider = "",
  onClose,
  onImported,
}: {
  providers: ProviderSummary[];
  initialProvider?: string;
  onClose: () => void;
  onImported: (r: ImportResult) => void;
}) {
  const [providerName, setProviderName] = useState(initialProvider ?? "");
  const [sourceKind, setSourceKind] = useState<SourceKind>("link");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState("");
  const [mode, setMode] = useState<Mode>("merge");
  const [defaultVerified, setDefaultVerified] = useState(true);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<ApiFailure | Error | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const reset = () => {
    setPreview(null);
    setMapping({});
    setStale(false);
    setError(null);
  };

  const ready = providerName.trim().length >= 2 && (sourceKind === "link" ? url.trim().length > 8 : Boolean(file));
  const known = providers.find((p) => [p.id, p.name].some((v) => v.toLowerCase() === providerName.trim().toLowerCase()));

  async function submit(action: "preview" | "import") {
    setBusy(action);
    setError(null);
    const form = new FormData();
    form.set("action", action);
    form.set("providerName", providerName.trim());
    form.set("sourceKind", sourceKind);
    if (sourceKind === "link") form.set("url", url.trim());
    else if (file) form.set("file", file);
    if (sheet.trim()) form.set("sheet", sheet.trim());
    form.set("mode", mode);
    form.set("defaultVerified", String(defaultVerified));
    if (preview) form.set("mapping", JSON.stringify(mapping));
    try {
      const data = await api<ImportPreview | ImportResult>("/api/admin/astrologers/import", { method: "POST", body: form });
      setPreview(data);
      setMapping(data.mapping);
      setStale(false);
      if (action === "import") {
        setResult(data as ImportResult);
        onImported(data as ImportResult);
      }
    } catch (e) {
      setError(e instanceof Error ? e : new Error(errorText(e)));
    } finally {
      setBusy(null);
    }
  }

  if (result) {
    const r = result.record;
    return (
      <Modal title="Astrologers added" onClose={onClose}>
        <div className="flex flex-col gap-4 p-5 text-sm">
          <Alert tone="green">
            Imported <b>{r.accepted}</b> of {r.rows} rows for <b>{r.providerName}</b> into MongoDB.
          </Alert>
          <dl className="grid grid-cols-3 gap-3 text-center">
            {[
              ["New", r.inserted],
              ["Updated", r.updated],
              ["Removed", r.removed],
              ["Rejected", r.rejected],
              ["Kept hidden", r.keptHidden],
              ["Took", `${(r.durationMs / 1000).toFixed(1)}s`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-zinc-200 p-2">
                <dt className="text-xs text-zinc-500">{k}</dt>
                <dd className="text-lg font-semibold text-zinc-900">{v}</dd>
              </div>
            ))}
          </dl>
          {!result.provider.rankable && (
            <Alert tone="amber">
              <b>{result.provider.name}</b> isn’t in <code>config/provider.config.ts</code>, so its astrologers are stored but won’t appear in
              ranking until the provider is added there (with target share and capacity).
            </Alert>
          )}
          {r.rejected > 0 && <RejectedList rows={result.rejectedSample} total={r.rejected} />}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setResult(null);
                setUrl("");
                setFile(null);
                reset();
              }}
            >
              Add another list
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add astrologers" onClose={onClose} wide={Boolean(preview)}>
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void submit(preview && !stale ? "import" : "preview");
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Provider name"
            hint={
              providerName.trim().length >= 2 &&
              (known ? (
                <>
                  Adds to existing provider <b>{known.name}</b> ({known.id})
                </>
              ) : (
                "A new provider will be created"
              ))
            }
          >
            <input
              className={inputCls}
              list="admin-provider-names"
              value={providerName}
              onChange={(e) => {
                setProviderName(e.target.value);
                reset();
              }}
              placeholder="e.g. AstroTalk Partners"
              autoFocus
              required
            />
            <datalist id="admin-provider-names">
              {providers.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
          </Field>

          <Field label="Mode">
            <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="merge">Add / update (keep astrologers not in this list)</option>
              <option value="replace">Replace roster (remove astrologers not in this list)</option>
            </select>
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex gap-1 text-sm">
            {(["link", "upload"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setSourceKind(k);
                  reset();
                }}
                className={`rounded px-3 py-1 ${sourceKind === k ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"}`}
              >
                {k === "link" ? "Paste link" : "Upload file"}
              </button>
            ))}
          </div>

          {sourceKind === "link" ? (
            <Field label="Astrologer list link" hint="Google Sheet, Google Drive, Dropbox or a direct .xlsx / .csv / .pdf / .json link. Shared links must be viewable by anyone with the link.">
              {/* Distinct keys: the link and file inputs share this slot, and reusing one DOM node flips it between controlled and uncontrolled. */}
              <input
                key="url"
                className={inputCls}
                type="url"
                value={url ?? ""}
                onChange={(e) => {
                  setUrl(e.target.value);
                  reset();
                }}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                required
              />
            </Field>
          ) : (
            <Field label="Astrologer list file" hint="Excel (.xlsx), CSV/TSV, PDF table or JSON — up to 15 MB.">
              <input
                key="file"
                className={`${inputCls} file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1`}
                type="file"
                accept=".xlsx,.csv,.tsv,.txt,.pdf,.json,application/pdf,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  reset();
                }}
                required
              />
            </Field>
          )}

          <details className="text-sm text-zinc-600">
            <summary className="cursor-pointer select-none">More options</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label="Worksheet name (Excel only)" hint="Defaults to the first sheet. For Google Sheets, open the tab you want before copying the link.">
                <input className={inputCls} value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="Sheet1" />
              </Field>
              <label className="flex items-start gap-2 pt-6">
                <input type="checkbox" checked={defaultVerified} onChange={(e) => setDefaultVerified(e.target.checked)} className="mt-0.5" />
                <span>Mark astrologers as verified when the list has no “verified” column</span>
              </label>
            </div>
          </details>
        </div>

        {error && (
          <Alert>
            <p className="font-medium">{error.message}</p>
            {error instanceof ApiFailure && error.issues.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {error.issues.slice(0, 8).map((i, n) => (
                  <li key={n}>
                    {i.path && <code>{i.path}</code>} {i.message}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        )}

        {preview && (
          <PreviewPanel
            preview={preview}
            mapping={mapping}
            onMapping={(m) => {
              setMapping(m);
              setStale(true);
            }}
          />
        )}

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-100 pt-4">
          {preview && stale && <span className="mr-auto text-xs text-amber-700">Mapping changed — refresh the preview to check it.</span>}
          <Button onClick={onClose}>Cancel</Button>
          {(!preview || stale) && (
            <Button type="submit" variant={preview ? "secondary" : "primary"} disabled={!ready || busy !== null}>
              {busy === "preview" ? "Reading list…" : preview ? "Refresh preview" : "Preview"}
            </Button>
          )}
          {preview && (
            <Button
              variant="primary"
              disabled={!ready || busy !== null || preview.accepted === 0}
              onClick={() => {
                if (mode === "replace" && !confirm(`Replace ${preview.provider.name}'s roster? Astrologers not in this list will be removed.`)) return;
                void submit("import");
              }}
            >
              {busy === "import" ? "Saving to database…" : `Import ${stale ? "" : `${preview.accepted} `}astrologers`}
            </Button>
          )}
        </footer>
      </form>
    </Modal>
  );
}

function PreviewPanel({ preview, mapping, onMapping }: { preview: ImportPreview; mapping: ColumnMapping; onMapping: (m: ColumnMapping) => void }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-zinc-50/60 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="indigo">{FORMAT_LABEL[preview.format]}</Badge>
        {preview.fileName && <span className="text-xs text-zinc-500">{preview.fileName}</span>}
        <span className="text-zinc-700">
          {preview.rows} rows → <b className="text-emerald-700">{preview.accepted} valid</b>
          {preview.rejected > 0 && <b className="text-rose-700">, {preview.rejected} rejected</b>}
        </span>
        <span className="ml-auto text-xs text-zinc-500">
          Provider id <code>{preview.provider.id}</code> {preview.provider.existing ? "(existing)" : "(new)"}
        </span>
      </div>

      <div>
        <h3 className="mb-1 font-medium text-zinc-800">Column mapping</h3>
        <p className="mb-2 text-xs text-zinc-500">
          Detected automatically — change any column that’s wrong. Name and Price per minute are required.
          {preview.contactColumns.length > 0 && ` Contact columns (${preview.contactColumns.join(", ")}) are never imported.`}
        </p>
        <div className="grid max-h-64 gap-x-4 gap-y-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
          {preview.headers.map((h) => {
            const contact = preview.contactColumns.includes(h);
            return (
              <label key={h} className="flex items-center justify-between gap-2">
                <span className="truncate text-zinc-700" title={h}>
                  {h}
                </span>
                <select
                  className={`w-52 shrink-0 rounded border px-1.5 py-1 text-xs ${mapping[h] === "ignore" ? "border-zinc-200 text-zinc-400" : "border-zinc-300 text-zinc-900"}`}
                  value={mapping[h] ?? "ignore"}
                  disabled={contact}
                  onChange={(e) => onMapping({ ...mapping, [h]: e.target.value as ColumnMapping[string] })}
                >
                  <option value="ignore">{contact ? "Not imported (contact)" : "— ignore —"}</option>
                  {IMPORT_FIELDS.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </div>

      {preview.sample.length > 0 && (
        <div>
          <h3 className="mb-1 font-medium text-zinc-800">How they’ll be saved (first {preview.sample.length})</h3>
          <div className="overflow-x-auto rounded border border-zinc-200 bg-white">
            <table className="w-full text-xs">
              <thead className="bg-zinc-50 text-left text-zinc-500">
                <tr>
                  {["Name", "₹/min", "Languages", "Expertise", "Exp", "Rating", "Status", "Verified"].map((h) => (
                    <th key={h} className="px-2 py-1.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((a) => (
                  <tr key={a.id} className="border-t border-zinc-100">
                    <td className="px-2 py-1.5 font-medium text-zinc-900">{a.name}</td>
                    <td className="px-2 py-1.5">{inr(a.perMinute)}</td>
                    <td className="px-2 py-1.5">{a.languages.join(", ") || "—"}</td>
                    <td className="px-2 py-1.5">{a.expertise.join(", ") || "—"}</td>
                    <td className="px-2 py-1.5">{a.experienceYears ?? "—"}</td>
                    <td className="px-2 py-1.5">{a.rating ?? "—"}</td>
                    <td className="px-2 py-1.5">{a.status}</td>
                    <td className="px-2 py-1.5">{a.verified ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview.unmapped.length > 0 && (
        <p className="text-xs text-zinc-600">
          <b>Values not in the catalog</b> (kept out of filters; add aliases in <code>config/catalog.config.ts</code>):{" "}
          {preview.unmapped.map(([v, n]) => `${v} ×${n}`).join(" · ")}
        </p>
      )}

      {preview.rejected > 0 && <RejectedList rows={preview.rejectedSample} total={preview.rejected} />}
    </section>
  );
}

export function RejectedList({ rows, total }: { rows: ImportPreview["rejectedSample"]; total: number }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none font-medium text-rose-700">
        {total} row{total === 1 ? "" : "s"} rejected — see why
      </summary>
      <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-zinc-700">
        {rows.map((r) => (
          <li key={r.ref}>
            <b>{r.ref}</b>: {r.issues.map((i) => `${i.path ? `${i.path} ` : ""}${i.message}`).join("; ")}
          </li>
        ))}
        {total > rows.length && <li className="text-zinc-500">…and {total - rows.length} more</li>}
      </ul>
    </details>
  );
}
