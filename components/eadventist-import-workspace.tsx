"use client";

import { useState } from "react";
import { CheckCircle2, FileUp, Upload } from "lucide-react";
import { disbandedNotice, NEW_RECORD, organizationKindLabels } from "@/modules/organizations/eadventist-import";
import type { ImportPreview } from "@/modules/organizations/eadventist-import-repository";

const actionLabels = { NEW: "New", UPDATED: "Updated", UNCHANGED: "Unchanged", SKIPPED: "Skipped" } as const;
const actionTone = { NEW: "green", UPDATED: "purple", UNCHANGED: "", SKIPPED: "gold" } as const;

type ApiError = { message?: string; issues?: Array<{ message?: string }> };

/**
 * Admin upload for the eAdventist organizations export (#649): choose the CSV,
 * review what it would add, update, leave alone, or flag, then save. The file
 * stays in this page's memory and is sent again on save, so the server plans
 * the save from the database as it is then. `initialPreview` starts on an
 * already-read file (render tests).
 */
export function EadventistImportWorkspace({ initialPreview }: { initialPreview?: ImportPreview }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(initialPreview ?? null);
  const [saved, setSaved] = useState(false);
  // "Possible match" choices: OrganizationID to a stored organization id, or "NEW".
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(text: string, confirm: boolean, chosen: Record<string, string> = choices) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/organizations/eadventist-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, confirm, choices: chosen }),
      });
      const result = await response.json().catch(() => ({})) as ImportPreview & ApiError;
      if (!response.ok || !result.items) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That file couldn't be read.");
      setPreview(result);
      setSaved(confirm);
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
    if (!file.name.toLowerCase().endsWith(".csv") && !file.type.toLowerCase().startsWith("text/")) {
      setError("Choose a .csv file.");
      return;
    }
    const text = await file.text();
    setCsv(text);
    setSaved(false);
    setChoices({});
    await send(text, false, {});
  }

  const counts = preview?.counts;
  const changes = counts ? counts.new + counts.updated : 0;
  const waiting = preview?.needsChoice ?? 0;

  return (
    <section className="panel" aria-labelledby="eadventist-import-title">
      <div className="section-head">
        <div>
          <p className="eyebrow">Clubs and churches</p>
          <h1 id="eadventist-import-title">Import organizations from eAdventist</h1>
          <p className="field-help">
            Upload the organizations export (CSV). Nothing is saved until you review the list and choose Save. Records are matched by their
            eAdventist OrganizationID, so uploading a newer file updates them instead of adding copies. Whether a record is active is never changed by an
            upload; use the directory list for that.
          </p>
        </div>
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {!preview && (
        <label className="club-import-upload">
          <FileUp aria-hidden="true" size={24} />
          <strong>{busy ? "Reading…" : "Choose the eAdventist organizations CSV"}</strong>
          <input accept=".csv,text/csv" disabled={busy} onChange={readFile} type="file" />
        </label>
      )}
      {preview && counts && (
        <>
          <p className="field-help" data-testid="eadventist-import-summary">
            {saved ? <><CheckCircle2 aria-hidden="true" size={14} /> Saved. </> : "Nothing is saved yet. "}
            {waiting > 0 && <strong>{waiting} possible {waiting === 1 ? "match needs" : "matches need"} a choice before you can save. </strong>}
            {counts.new} new, {counts.updated} updated, {counts.unchanged} unchanged, {counts.skipped} skipped. {counts.flagged} with a disbanded date on file to review.
            {" "}Church map locations: {preview.locationCounts.created} to create, {preview.locationCounts.updated} to update (town, state and ZIP only; hand-set locations are never changed).
          </p>
          {preview.rejected.length > 0 && (
            <div className="inline-notice" role="status">
              <strong>{preview.rejected.length} {preview.rejected.length === 1 ? "row was" : "rows were"} not read:</strong>
              <ul>
                {preview.rejected.map((row) => <li key={row.line}>Row {row.line}{row.name ? ` (${row.name})` : ""}: {row.reason}</li>)}
              </ul>
            </div>
          )}
          <div className="report-table-wrap">
            <table className="report-table">
              <thead><tr><th>Row</th><th>Name</th><th>Kind</th><th>What happens</th></tr></thead>
              <tbody>
                {preview.items.map((item) => (
                  <tr key={item.line}>
                    <td>{item.line}</td>
                    <td translate="no">{item.name}</td>
                    <td>{organizationKindLabels[item.kind]}</td>
                    <td>
                      <span className={`status-chip ${actionTone[item.action]}`}>{actionLabels[item.action]}</span>
                      {(item.possibleMatches.length > 0 || item.needsChoice) && <span className="status-chip gold">{item.needsChoice ? "Possible match — choose" : "Possible match"}</span>}
                      {item.notes.map((note) => <div className="field-help" key={note}>{note}</div>)}
                      {(item.possibleMatches.length > 0 || item.needsChoice) && !saved && (
                        <select
                          aria-label={`Possible match for ${item.name}`}
                          disabled={busy}
                          onChange={(event) => {
                            const next = { ...choices, [item.eadventistId]: event.target.value };
                            setChoices(next);
                            if (csv) void send(csv, false, next);
                          }}
                          value={item.selectedMatch ?? ""}
                        >
                          {item.selectedMatch === null && <option value="">Choose…</option>}
                          {item.possibleMatches.map((match) => <option key={match.id} value={match.id}>Link to {match.name}</option>)}
                          <option value={NEW_RECORD}>Create new</option>
                        </select>
                      )}
                      {item.locationAction && <div className="field-help">{item.locationAction === "CREATE" ? "Map location will be created." : "Map location will be updated."}</div>}
                      {item.disbandedOn && <div className="field-help">{disbandedNotice(item.disbandedOn, true)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button className="secondary-button" disabled={busy} onClick={() => { setPreview(null); setCsv(null); setSaved(false); setChoices({}); }} type="button">
              {saved ? "Upload another file" : "Cancel"}
            </button>
            {!saved && (
              <button className="primary-button" disabled={busy || !csv || changes === 0 || waiting > 0} onClick={() => csv && send(csv, true)} type="button">
                <Upload aria-hidden="true" size={16} /> {busy ? "Saving…" : `Save ${changes} change${changes === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
