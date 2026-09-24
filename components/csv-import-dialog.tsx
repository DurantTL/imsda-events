"use client";

import { useCallback, useRef, useState } from "react";
import { Download, FileUp, Upload, X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";

export type CsvImportStep = { line: number; name: string; action: "ADD" | "UPDATE" | "SKIP"; message: string };
type ImportResponse = { steps?: CsvImportStep[]; message?: string; issues?: Array<{ message?: string }> } & Record<string, unknown>;

/**
 * Whether a chosen or dropped file is a CSV (#424). Browsers and operating
 * systems label CSVs inconsistently: some drops arrive with no type at all,
 * and Windows often calls them `application/vnd.ms-excel` or `text/plain`. So
 * a `.csv` name (any case) is trusted whatever its type, and `text/csv` is
 * trusted whatever the name. The server still parses and checks the content.
 */
export function isCsvFile(file: { name: string; type: string }) {
  const type = file.type.toLowerCase().split(";")[0]!.trim();
  return type === "text/csv" || file.name.trim().toLowerCase().endsWith(".csv");
}

const actionLabels = { ADD: "Add", UPDATE: "Update", SKIP: "Skip" } as const;
const actionTone = { ADD: "green", UPDATE: "purple", SKIP: "gold" } as const;

/**
 * A CSV upload with a preview (#384, #385): download the template, choose a
 * file, see what each row will do, then confirm. The endpoint answers
 * `{ csv, confirm: false }` with a preview and `{ csv, confirm: true }` by
 * saving; both return `steps`.
 */
export function CsvImportDialog({
  eyebrow,
  help,
  importUrl,
  onImported,
  templateHref,
  title,
  variant = "account",
}: {
  eyebrow: string;
  help: React.ReactNode;
  importUrl: string;
  onImported: (result: ImportResponse) => void;
  templateHref: string;
  title: string;
  variant?: "account" | "staff";
}) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [steps, setSteps] = useState<CsvImportStep[] | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  // Entering and leaving the label's own children fires dragleave on the
  // label too, so count enters and leaves instead of flickering (#424).
  const dragDepth = useRef(0);
  const close = useCallback(() => {
    setOpen(false);
    setCsv(null);
    setSteps(null);
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
      const response = await fetch(importUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, confirm }),
      });
      const result = await response.json().catch(() => ({})) as ImportResponse;
      if (!response.ok || !result.steps) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That file couldn't be read.");
      setSteps(result.steps);
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

  async function readFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await openFile(file);
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

  function onDragEnter(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current += 1;
    if (!busy) setDragging(true);
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

  function onDragOver(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!busy) setDragging(true);
  }

  function onDragLeave(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  const counts = { ADD: 0, UPDATE: 0, SKIP: 0 };
  for (const step of steps ?? []) counts[step.action] += 1;
  const changes = counts.ADD + counts.UPDATE;

  return (
    <>
      <a className="text-button" href={templateHref}><Download aria-hidden="true" size={14} /> CSV template</a>
      <button className="text-button" onClick={() => setOpen(true)} type="button"><Upload aria-hidden="true" size={14} /> Upload CSV</button>
      {open && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }} role="presentation">
          <section aria-labelledby="csv-import-title" aria-modal="true" className="modal-card roster-csv-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
            <div className="modal-head">
              <div>
                <p className={variant === "account" ? "public-registration-eyebrow" : "eyebrow"}>{eyebrow}</p>
                <h2 id="csv-import-title">{done ? "Saved" : title}</h2>
              </div>
              <button aria-label="Close" className="icon-button modal-close-button" onClick={close} type="button"><X aria-hidden="true" size={18} /></button>
            </div>
            {error && <div className="inline-notice error" role="alert">{error}</div>}
            {!steps && (
              <>
                <div className="field-help">{help}</div>
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
                  {done ? "Done." : "Nothing is saved yet."} {counts.ADD} to add, {counts.UPDATE} to update, {counts.SKIP} skipped.
                </p>
                <div className="report-table-wrap roster-csv-preview">
                  <table className="report-table">
                    <thead><tr><th>Row</th><th>Name</th><th>What happens</th></tr></thead>
                    <tbody>
                      {steps.map((step) => (
                        <tr key={step.line}>
                          <td>{step.line}</td>
                          <td translate="no">{step.name || "—"}</td>
                          <td><span className={`status-chip ${actionTone[step.action]}`}>{actionLabels[step.action]}</span> {step.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
