"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TrainingJob } from "@/lib/ranking/ml/trainJob";
import { api, ApiFailure, errorText, fmtDate } from "./controls/api";
import { Alert, Button, Field, Modal } from "./controls/ui";

/** "yyyy-MM-ddTHH:mm" in local time, for datetime-local inputs. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

const STATE_TONE = { trained: "green", not_written: "amber", failed: "rose" } as const;

/** Starts Layer-4 (ML ranking) training on the lists served between two times. */
export default function TrainModelButton() {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [job, setJob] = useState<TrainingJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [starting, setStarting] = useState(false);
  /** Run started from this popup; an earlier run's result isn't shown, only a run still in progress. */
  const [startedId, setStartedId] = useState<string | null>(null);
  const running = job?.state === "running";
  const shown = job && (running || job.id === startedId) ? job : null;

  const refresh = useCallback(() => {
    api<{ job: TrainingJob | null }>("/api/admin/ml/train")
      .then((d) => setJob(d.job))
      .catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    if (!open || !running) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [open, running, refresh]);

  function show() {
    const now = Date.now();
    setFrom(toLocalInput(now - 30 * 86_400_000));
    setTo(toLocalInput(now));
    setError(null);
    setIssues([]);
    setFile(null);
    setStartedId(null);
    setOpen(true);
    refresh();
  }

  async function start() {
    const f = new Date(from).getTime();
    const t = new Date(to).getTime();
    if (!Number.isFinite(f) || !Number.isFinite(t)) return setError("Pick a start and an end time.");
    if (f >= t) return setError("Start must be before end.");
    setStarting(true);
    setError(null);
    setIssues([]);
    try {
      let init: Parameters<typeof api>[1];
      if (file) {
        const form = new FormData();
        form.set("from", String(f));
        form.set("to", String(t));
        form.set("file", file);
        init = { method: "POST", body: form };
      } else {
        init = { method: "POST", json: { from: f, to: t } };
      }
      const started = (await api<{ job: TrainingJob }>("/api/admin/ml/train", init)).job;
      setStartedId(started.id);
      setJob(started);
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiFailure) setIssues(e.issues);
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={show}>
        Start Training ML Model
      </Button>
      {open && (
        <Modal title="Train Layer 4 — ML ranking" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3 p-5">
            <p className="text-sm text-zinc-600">Trains the ranker on the lists served in this time range and their clicks, bookings and completed consultations.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From">
                <input type="datetime-local" value={from} max={to} onChange={(e) => setFrom(e.target.value)} disabled={running} className="rounded border border-zinc-300 px-2 py-1" />
              </Field>
              <Field label="To">
                <input type="datetime-local" value={to} min={from} onChange={(e) => setTo(e.target.value)} disabled={running} className="rounded border border-zinc-300 px-2 py-1" />
              </Field>
            </div>

            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-700">Training data</span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".jsonl,.json,.txt,application/json"
                  className="hidden"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    e.target.value = ""; // allow re-picking the same file
                  }}
                />
                <Button onClick={() => fileInput.current?.click()} disabled={running}>
                  Import data
                </Button>
                {file ? (
                  <>
                    <span className="text-zinc-700">
                      {file.name} <span className="text-zinc-400">({Math.max(1, Math.round(file.size / 1024))} KB)</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setFile(null)} disabled={running}>
                      Remove
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-zinc-500">Optional — logged data only</span>
                )}
              </div>
              <span className="text-xs text-zinc-500">
                A training.jsonl in the <code>npm run ml:export</code> format (up to 25 MB). Its rows within From–To are added to the logged data.
              </span>
            </div>

            {error && (
              <Alert>
                {error}
                {issues.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-xs">
                    {issues.map((i) => (
                      <li key={`${i.path}-${i.message}`}>
                        {i.path}: {i.message}
                      </li>
                    ))}
                  </ul>
                )}
              </Alert>
            )}

            {shown && (
              <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 text-sm">
                {shown.state === "running" ? (
                  <p className="font-medium text-zinc-800">{shown.message}</p>
                ) : (
                  <Alert tone={STATE_TONE[shown.state]}>{shown.message}</Alert>
                )}
                <p className="text-xs text-zinc-500">
                  {fmtDate(shown.from)} → {fmtDate(shown.to)}
                  {shown.imported ? ` · + ${shown.imported}` : ""} · started {fmtDate(shown.startedAt)}
                  {shown.finishedAt ? ` · finished ${fmtDate(shown.finishedAt)}` : ""}
                </p>
                {shown.log.length > 0 && <pre className="max-h-48 overflow-auto rounded bg-zinc-50 p-2 text-[11px] text-zinc-700">{shown.log.join("\n")}</pre>}
              </div>
            )}

            <p className="rounded-lg bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-800">
              {file ? `Training on system data + imported file data (${file.name})` : "Training on system data"}
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button variant="primary" onClick={start} disabled={running || starting}>
                {running ? "Training…" : starting ? "Starting…" : "Start training"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
