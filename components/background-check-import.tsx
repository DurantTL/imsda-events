"use client";

import { useCallback, useRef, useState } from "react";
import { Download, FileUp, Upload, X } from "lucide-react";
import { isCsvFile } from "@/components/csv-import-dialog";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";

type RowProblem = { line: number; name: string; problems: string[] };
type ImportResponse = {
  format?: "ROSTER" | "STERLING";
  problems?: RowProblem[];
  added?: number;
  changed?: number;
  dropped?: number;
  total?: number;
  /** What the preview was computed against; echoed back on confirm (#527). */
  fingerprint?: string;
  replacesMigratedList?: boolean;
  error?: string;
  message?: string;
  issues?: Array<{ message?: string }>;
};

/**
 * The background-check CSV upload (#388, #427, #527): one stored list,
 * replaced wholesale on every upload. Previews the counts an upload would
 * change — added, changed, dropped — before saving; matching a row to a
 * person happens afterward, at lookup, not here.
 */
export function BackgroundCheckImport({ onImported }: { onImported: (result: ImportResponse) => void }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setCsv(null);
    setPreview(null);
    setDone(false);
    setError("");
    setDragging(false);
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
        body: JSON.stringify({ csv: text, confirm, ...(confirm && preview?.fingerprint ? { fingerprint: preview.fingerprint } : {}) }),
      });
      const result = await response.json().catch(() => ({})) as ImportResponse;
      if (response.status === 409 && result.error === "PREVIEW_CHANGED") {
        // The list or the file changed since this preview: show the current counts instead.
        setPreview(null);
        await send(text, false);
        setError(`${result.message ?? "The list changed since this preview."} The counts below are current; review them and save again.`);
        return;
      }
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That file couldn't be read.");
      setPreview(result);
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

  const problems = preview?.problems ?? [];
  const changeCount = (preview?.added ?? 0) + (preview?.changed ?? 0) + (preview?.dropped ?? 0);

  return (
    <>
      <a className="text-button" href="/api/admin/background-checks/template"><Download aria-hidden="true" size={14} /> CSV template</a>
      <button className="text-button" onClick={() => setOpen(true)} type="button"><Upload aria-hidden="true" size={14} /> Upload CSV</button>
      {open && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }} role="presentation">
          <section aria-labelledby="background-check-import-title" aria-modal="true" className="modal-card roster-csv-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
            <div className="modal-head">
              <div>
                <p className="eyebrow">Sterling Volunteers</p>
                <h2 id="background-check-import-title">{done ? "Saved" : "Upload Sterling Volunteers"}</h2>
              </div>
              <button aria-label="Close" className="icon-button modal-close-button" onClick={close} type="button"><X aria-hidden="true" size={18} /></button>
            </div>
            {error && <div className="inline-notice error" role="alert">{error}</div>}
            {!preview && (
              <>
                <div className="field-help">
                  <p>
                    Upload the roster export (<code>user_id, user_last, user_first, roles, sites, user_active,
                    compliance, issues</code>) or the older Sterling Volunteers CSV; either is read automatically.
                    In <code>compliance</code>, <code>y</code> is clear, <code>!</code> is expiring soon, and{" "}
                    <code>n</code> is not in compliance. <code>user_active</code> is ignored.
                  </p>
                  <p>
                    This upload is the complete current list: it replaces whatever was on file. A person missing
                    from the new file stops counting as checked. Matching a row to a person happens whenever
                    they&apos;re looked up — a family member added to a roster later still picks up their check
                    without a re-upload. An uncertain or unmatched row is never guessed; it goes to the review list
                    or stays on the list as unmatched.
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
            {preview && (
              <>
                <p className="field-help">
                  {done ? "Saved." : "Nothing is saved yet."} {preview.format === "ROSTER" ? "Roster" : "Sterling Volunteers"} format detected,{" "}
                  {preview.total ?? 0} valid row{(preview.total ?? 0) === 1 ? "" : "s"}.
                </p>
                {!done && preview.replacesMigratedList && preview.format === "STERLING" && (
                  <p className="inline-notice" role="note">
                    This is the first Sterling upload since the list moved to its new format. The checks carried over
                    from before have no email on file, so they show as dropped and this file&apos;s rows as added. That&apos;s
                    expected: after saving, people are matched from this file as usual.
                  </p>
                )}
                <section className="report-summary-grid" aria-label="What this upload changes">
                  <article className="metric-card report-summary-card accent-green">
                    <strong>{preview.added ?? 0}</strong><p>Added</p>
                  </article>
                  <article className="metric-card report-summary-card accent-purple">
                    <strong>{preview.changed ?? 0}</strong><p>Changed</p>
                  </article>
                  <article className="metric-card report-summary-card accent-coral">
                    <strong>{preview.dropped ?? 0}</strong><p>Dropped</p>
                  </article>
                </section>
                {problems.length > 0 && (
                  <div className="report-table-wrap roster-csv-preview">
                    <p className="field-help">{problems.length} row{problems.length === 1 ? "" : "s"} couldn&apos;t be read, or repeat{problems.length === 1 ? "s" : ""} another row&apos;s person, and won&apos;t be saved:</p>
                    <table className="report-table">
                      <thead><tr><th>Row</th><th>Name</th><th>Problem</th></tr></thead>
                      <tbody>
                        {problems.slice(0, 100).map((problem) => (
                          <tr key={problem.line}>
                            <td>{problem.line}</td>
                            <td translate="no">{problem.name || "—"}</td>
                            <td>{problem.problems.join(" ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="form-actions">
                  <button className="secondary-button" disabled={busy} onClick={close} type="button">{done ? "Close" : "Cancel"}</button>
                  {!done && (
                    <button className="primary-button" disabled={busy || !csv || changeCount === 0} onClick={() => csv && send(csv, true)} type="button">
                      <Upload aria-hidden="true" size={16} /> {busy ? "Saving…" : `Save ${changeCount} change${changeCount === 1 ? "" : "s"}`}
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
