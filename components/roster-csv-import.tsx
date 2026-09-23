"use client";

import { useCallback, useState } from "react";
import { Download, FileUp, Upload, X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

type Step = { line: number; name: string; action: "ADD" | "UPDATE" | "SKIP"; message: string };
type ImportResponse = { steps?: Step[]; added?: number; updated?: number; members?: RosterMemberRecord[]; message?: string; issues?: Array<{ message?: string }> };

const actionLabels = { ADD: "Add", UPDATE: "Update", SKIP: "Skip" } as const;
const actionTone = { ADD: "green", UPDATE: "purple", SKIP: "gold" } as const;

/**
 * Roster CSV (#384): download the template, upload a filled-in file, see
 * what will be added, updated, or skipped, then confirm.
 */
export function RosterCsvImport({ base, onImported }: { base: string; onImported: (members: RosterMemberRecord[], message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = useCallback(() => {
    setOpen(false);
    setCsv(null);
    setSteps(null);
    setDone(false);
    setError("");
  }, []);
  const dialogRef = useAccessibleDialog<HTMLElement>(open, close);

  async function send(text: string, confirm: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${base}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, confirm }),
      });
      const result = await response.json().catch(() => ({})) as ImportResponse;
      if (!response.ok || !result.steps) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That file couldn't be read.");
      setSteps(result.steps);
      if (confirm && result.members) {
        setDone(true);
        onImported(result.members, `Roster updated: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`);
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
    const text = await file.text();
    setCsv(text);
    await send(text, false);
  }

  const counts = { ADD: 0, UPDATE: 0, SKIP: 0 };
  for (const step of steps ?? []) counts[step.action] += 1;

  return (
    <>
      <a className="text-button" href={`${base}/template`}><Download aria-hidden="true" size={14} /> CSV template</a>
      <button className="text-button" onClick={() => setOpen(true)} type="button"><Upload aria-hidden="true" size={14} /> Upload CSV</button>
      {open && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }} role="presentation">
          <section aria-labelledby="roster-csv-title" aria-modal="true" className="modal-card roster-csv-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
            <div className="modal-head">
              <div>
                <p className="public-registration-eyebrow">Roster CSV</p>
                <h2 id="roster-csv-title">{done ? "Roster updated" : "Upload a roster file"}</h2>
              </div>
              <button aria-label="Close" className="icon-button modal-close-button" onClick={close} type="button"><X aria-hidden="true" size={18} /></button>
            </div>
            {error && <div className="inline-notice error" role="alert">{error}</div>}
            {!steps && (
              <>
                <p className="field-help">
                  Fill in the <a href={`${base}/template`}>CSV template</a> (First name, Last name, Birth date, Type, Class, Role,
                  Gender) in Excel or Google Sheets and save it as CSV. People already on this year&apos;s roster are matched by
                  name and updated with whatever the file fills in; blank cells are left as they are. New people need a birth date.
                </p>
                <label className="club-import-upload">
                  <FileUp aria-hidden="true" size={24} />
                  <strong>{busy ? "Reading…" : "Choose the CSV file"}</strong>
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
                    <button className="primary-button" disabled={busy || !csv || counts.ADD + counts.UPDATE === 0} onClick={() => csv && send(csv, true)} type="button">
                      <Upload aria-hidden="true" size={16} /> {busy ? "Saving…" : `Save ${counts.ADD + counts.UPDATE} change${counts.ADD + counts.UPDATE === 1 ? "" : "s"}`}
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
