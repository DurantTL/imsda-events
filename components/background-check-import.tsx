"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Download, FileUp, Upload, X } from "lucide-react";
import { isCsvFile } from "@/components/csv-import-dialog";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";

type ImportAction = "ADD" | "UPDATE" | "SKIP" | "REVIEW";
type ImportStep = {
  line: number;
  name: string;
  action: ImportAction;
  message: string;
  candidates?: Array<{ personId: string; site: string | null }>;
  /** Roster import only, staff-only, and shown for every row (#427). */
  note?: string | null;
};
type ImportResponse = {
  format?: "ROSTER" | "STERLING";
  steps?: ImportStep[];
  added?: number;
  updated?: number;
  message?: string;
  issues?: Array<{ message?: string }>;
};

const actionLabels = { ADD: "Add", UPDATE: "Update", SKIP: "Not found", REVIEW: "Needs review" } as const;
const actionTone = { ADD: "green", UPDATE: "purple", SKIP: "gold", REVIEW: "coral" } as const;
const PAGE_SIZE = 50;

type Filter = "ALL" | "MATCHED" | "REVIEW" | "NOT_FOUND";

function filterMatches(filter: Filter, step: ImportStep) {
  if (filter === "ALL") return true;
  if (filter === "MATCHED") return step.action === "ADD" || step.action === "UPDATE";
  if (filter === "REVIEW") return step.action === "REVIEW";
  return step.action === "SKIP";
}

/**
 * The background check CSV upload (#388, #427): preview with filters and
 * paging (up to 5,000 rows), then confirm. Accepts the real roster export or
 * the older Sterling Volunteers export; the server tells them apart.
 */
export function BackgroundCheckImport({ onImported }: { onImported: (result: ImportResponse) => void }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [format, setFormat] = useState<"ROSTER" | "STERLING" | null>(null);
  const [steps, setSteps] = useState<ImportStep[] | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [page, setPage] = useState(0);
  const dragDepth = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setCsv(null);
    setFormat(null);
    setSteps(null);
    setDone(false);
    setError("");
    setDragging(false);
    setFilter("ALL");
    setPage(0);
    dragDepth.current = 0;
  }, []);
  const dialogRef = useAccessibleDialog<HTMLElement>(open, close);

  async function send(text: string, confirm: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/background-checks/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, confirm }),
      });
      const result = await response.json().catch(() => ({})) as ImportResponse;
      if (!response.ok || !result.steps) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That file couldn't be read.");
      setSteps(result.steps);
      setFormat(result.format ?? null);
      setFilter("ALL");
      setPage(0);
      if (confirm) {
        setDone(true);
        onImported(result);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That file couldn't be read.");
    } finally {
      setBusy(false);
    }
  }

  async function openFile(file: File) {
    if (!isCsvFile(file)) {
      setError("Drop a .csv file.");
      return;
    }
    const text = await file.text();
    setCsv(text);
    await send(text, false);
  }

  async function readFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await openFile(file);
  }

  function onDragEnter(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current += 1;
    if (!busy) setDragging(true);
  }
  function onDragOver(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!busy) setDragging(true);
  }
  function onDragLeave(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function onDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      setError("Drop one CSV file.");
      return;
    }
    void openFile(files[0]);
  }

  const counts = { ADD: 0, UPDATE: 0, SKIP: 0, REVIEW: 0 };
  for (const step of steps ?? []) counts[step.action] += 1;
  const changes = counts.ADD + counts.UPDATE;

  const filtered = useMemo(() => (steps ?? []).filter((step) => filterMatches(filter, step)), [steps, filter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  function chooseFilter(next: Filter) {
    setFilter(next);
    setPage(0);
  }

  return (
    <>
      <a className="text-button" href="/api/admin/background-checks/template"><Download aria-hidden="true" size={14} /> CSV template</a>
      <button className="text-button" onClick={() => setOpen(true)} type="button"><Upload aria-hidden="true" size={14} /> Upload CSV</button>
      {open && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }} role="presentation">
          <section aria-labelledby="background-check-import-title" aria-modal="true" className="modal-card roster-csv-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
            <div className="modal-head">
              <div>
                <p className="eyebrow">Background checks</p>
                <h2 id="background-check-import-title">{done ? "Saved" : "Upload background checks"}</h2>
              </div>
              <button aria-label="Close" className="icon-button modal-close-button" onClick={close} type="button"><X aria-hidden="true" size={18} /></button>
            </div>
            {error && <div className="inline-notice error" role="alert">{error}</div>}
            {!steps && (
              <>
                <div className="field-help">
                  <p>
                    Upload the roster export (<code>user_id, user_last, user_first, roles, sites, user_active,
                    compliance, issues</code>) or the older Sterling Volunteers CSV; either is read automatically.
                  </p>
                  <p>
                    Roster rows are matched by name, narrowed by <code>sites</code> (a church or club name) when more
                    than one person shares a name. A row that stays ambiguous, or matches no one, is listed to review
                    by hand &mdash; nothing is guessed. Once matched, a row&apos;s <code>user_id</code> is remembered, so
                    the next upload matches on it first.
                  </p>
                  <p>Up to 5,000 rows at a time. The file itself is never stored.</p>
                </div>
                <label
                  className={`club-import-upload${dragging ? " club-import-upload-dragging" : ""}`}
                  onDragEnter={onDragEnter}
                  onDragLeave={onDragLeave}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                >
                  <FileUp aria-hidden="true" size={24} />
                  <strong>{busy ? "Reading…" : dragging ? "Drop the CSV file" : "Drag the CSV file here, or choose it"}</strong>
                  <input accept=".csv,text/csv" disabled={busy} onChange={readFile} type="file" />
                </label>
              </>
            )}
            {steps && (
              <>
                <p className="field-help">
                  {done ? "Done." : "Nothing is saved yet."} {format === "ROSTER" ? "Roster" : "Sterling Volunteers"} format detected.{" "}
                  {changes} matched, {counts.REVIEW} to review, {counts.SKIP} not found.
                </p>
                <div className="intro-actions background-check-import-filters" role="tablist">
                  {([
                    ["ALL", `All (${steps.length})`],
                    ["MATCHED", `Matched (${changes})`],
                    ["REVIEW", `Needs review (${counts.REVIEW})`],
                    ["NOT_FOUND", `Not found (${counts.SKIP})`],
                  ] as const).map(([value, label]) => (
                    <button
                      aria-selected={filter === value}
                      className={filter === value ? "primary-button" : "secondary-button"}
                      key={value}
                      onClick={() => chooseFilter(value)}
                      role="tab"
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="report-table-wrap roster-csv-preview">
                  <table className="report-table">
                    <thead><tr><th>Row</th><th>Name</th><th>What happens</th><th>Candidates</th><th>Note (staff only)</th></tr></thead>
                    <tbody>
                      {pageRows.map((step) => (
                        <tr key={step.line}>
                          <td>{step.line}</td>
                          <td translate="no">{step.name || "—"}</td>
                          <td><span className={`status-chip ${actionTone[step.action]}`}>{actionLabels[step.action]}</span> {step.message}</td>
                          <td>
                            {step.candidates && step.candidates.length > 0
                              ? step.candidates.map((candidate) => candidate.site ?? "no location on file").join("; ")
                              : "—"}
                          </td>
                          <td>{step.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pageCount > 1 && (
                  <div className="intro-actions background-check-import-pager">
                    <button className="secondary-button" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))} type="button">
                      Previous
                    </button>
                    <span className="quiet-copy">Page {page + 1} of {pageCount} ({filtered.length} rows)</span>
                    <button className="secondary-button" disabled={page >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} type="button">
                      Next
                    </button>
                  </div>
                )}
                <div className="form-actions">
                  <button className="secondary-button" disabled={busy} onClick={close} type="button">{done ? "Close" : "Cancel"}</button>
                  {!done && (
                    <button className="primary-button" disabled={busy || !csv || changes === 0} onClick={() => csv && send(csv, true)} type="button">
                      <Upload aria-hidden="true" size={16} /> {busy ? "Saving…" : `Save ${changes} change${changes === 1 ? "" : "s"}`}
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
