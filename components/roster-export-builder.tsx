"use client";

import { useMemo, useState } from "react";
import {
  DEFAULT_ROSTER_EXPORT_COLUMNS,
  ROSTER_EXPORT_COLUMNS,
  ROSTER_EXPORT_COLUMN_KEYS,
  isSensitiveRosterExportColumn,
  sensitiveRosterExportColumns,
  type RosterExportColumn,
  type RosterExportColumnKey,
} from "@/modules/club-rosters/export-columns";
import type { RosterExportFormatRecord } from "@/modules/club-rosters/export-repository";

type PreviewResponse = { headers?: string[]; rows?: string[][]; message?: string };
type FormatsResponse = { formats?: RosterExportFormatRecord[]; format?: RosterExportFormatRecord; message?: string };

const PREVIEW_ROW_LIMIT = 5;

function withDefaultHeader(key: RosterExportColumnKey): RosterExportColumn {
  return { key, header: ROSTER_EXPORT_COLUMNS[key].header };
}

/**
 * The director-facing roster export builder (#490): choose and order
 * columns, rename headers, preview the first rows, download a CSV, and save
 * or reuse a named format. Saved formats hold structure only — never a
 * frozen copy of the roster.
 */
export function RosterExportBuilder({
  organizationId,
  canSeeBirthDates,
  initialFormats,
}: {
  organizationId: string;
  /** Directors and deputies only (#375); a registrar can build an export but never the birth-date column. */
  canSeeBirthDates: boolean;
  initialFormats: RosterExportFormatRecord[];
}) {
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/roster/export`;
  const [columns, setColumns] = useState<RosterExportColumn[]>(DEFAULT_ROSTER_EXPORT_COLUMNS);
  const [confirmSensitive, setConfirmSensitive] = useState(false);
  const [preview, setPreview] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [formats, setFormats] = useState(initialFormats);
  const [formatName, setFormatName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const chosenKeys = useMemo(() => new Set(columns.map((column) => column.key)), [columns]);
  const available = ROSTER_EXPORT_COLUMN_KEYS.filter((key) => !chosenKeys.has(key));
  const sensitiveChosen = sensitiveRosterExportColumns(columns);
  const needsConfirmation = sensitiveChosen.length > 0;

  function addColumn(key: RosterExportColumnKey) {
    setPreview(null);
    setColumns((current) => (current.some((column) => column.key === key) ? current : [...current, withDefaultHeader(key)]));
  }

  function removeColumn(key: RosterExportColumnKey) {
    setPreview(null);
    setColumns((current) => {
      const next = current.filter((column) => column.key !== key);
      if (!sensitiveRosterExportColumns(next).length) setConfirmSensitive(false);
      return next;
    });
  }

  function moveColumn(index: number, delta: -1 | 1) {
    setPreview(null);
    setColumns((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = current.slice();
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function renameHeader(index: number, header: string) {
    setPreview(null);
    setColumns((current) => current.map((column, position) => (position === index ? { ...column, header } : column)));
  }

  async function request(mode: "preview" | "csv") {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, columns, confirmSensitive }),
      });
      if (mode === "csv" && response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "roster-export.csv";
        link.click();
        URL.revokeObjectURL(url);
        setNotice("Downloaded the roster export.");
        return;
      }
      const result = await response.json().catch(() => ({})) as PreviewResponse;
      if (!response.ok) throw new Error(result.message ?? "The export could not be built.");
      if (result.headers && result.rows) setPreview({ headers: result.headers, rows: result.rows });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The export could not be built.");
    } finally {
      setBusy(false);
    }
  }

  async function saveFormat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!formatName.trim()) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await fetch(`${base}/formats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: formatName.trim(), columns }),
      });
      const result = await response.json().catch(() => ({})) as FormatsResponse;
      if (!response.ok) throw new Error(result.message ?? "The format could not be saved.");
      if (result.formats) setFormats(result.formats);
      setFormatName("");
      setNotice(`Saved "${formatName.trim()}".`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The format could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  function applyFormat(format: RosterExportFormatRecord) {
    setPreview(null);
    setError("");
    setNotice(`Loaded "${format.name}".`);
    setColumns(format.columns);
    if (!sensitiveRosterExportColumns(format.columns).length) setConfirmSensitive(false);
  }

  async function deleteFormat(format: RosterExportFormatRecord) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await fetch(`${base}/formats/${encodeURIComponent(format.id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({})) as FormatsResponse;
      if (!response.ok) throw new Error(result.message ?? "The format could not be deleted.");
      if (result.formats) setFormats(result.formats);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The format could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  const blockedByBirthDateAccess = columns.some((column) => column.key === "birthDate") && !canSeeBirthDates;
  const canRun = columns.length > 0 && !blockedByBirthDateAccess && (!needsConfirmation || confirmSensitive);

  return (
    <div className="public-manage-card">
      <h2>Export builder</h2>
      <p className="quiet-copy">
        Build a CSV for an outside camporee: choose the columns it needs, put them in the order it wants, and rename
        the headers to match its template. Save the structure as a named format to reuse it next time.
      </p>

      {formats.length > 0 && (
        <section aria-labelledby="roster-export-formats-heading">
          <h3 id="roster-export-formats-heading">Saved formats</h3>
          <ul className="roster-export-format-list">
            {formats.map((format) => (
              <li key={format.id}>
                <button className="secondary-button" disabled={busy} onClick={() => applyFormat(format)} type="button">{format.name}</button>
                <button
                  aria-label={`Delete saved format "${format.name}"`}
                  className="text-button"
                  disabled={busy}
                  onClick={() => deleteFormat(format)}
                  type="button"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="roster-export-columns-heading">
        <h3 id="roster-export-columns-heading">Columns</h3>
        {available.length > 0 && (
          <div className="roster-export-add-column">
            <label htmlFor="roster-export-add-column">Add a column</label>
            <select
              id="roster-export-add-column"
              onChange={(event) => {
                if (isRosterExportColumnValue(event.target.value)) addColumn(event.target.value);
                event.target.value = "";
              }}
              value=""
            >
              <option value="">Choose a column…</option>
              {available.map((key) => (
                <option key={key} value={key}>
                  {ROSTER_EXPORT_COLUMNS[key].header}{isSensitiveRosterExportColumn(key) ? " (sensitive)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {columns.length === 0 ? (
          <p className="public-manage-empty">Choose at least one column to build an export.</p>
        ) : (
          <ol className="roster-export-column-list">
            {columns.map((column, index) => (
              <li key={column.key}>
                <span className="roster-export-column-order">{index + 1}</span>
                <label>
                  <span className="sr-only">Header name for {ROSTER_EXPORT_COLUMNS[column.key].header}</span>
                  <input
                    onChange={(event) => renameHeader(index, event.target.value)}
                    type="text"
                    value={column.header}
                  />
                </label>
                {isSensitiveRosterExportColumn(column.key) && <span className="status-chip gold">Sensitive</span>}
                <div className="roster-export-column-actions">
                  <button aria-label={`Move ${column.header} up`} className="text-button" disabled={index === 0} onClick={() => moveColumn(index, -1)} type="button">↑</button>
                  <button aria-label={`Move ${column.header} down`} className="text-button" disabled={index === columns.length - 1} onClick={() => moveColumn(index, 1)} type="button">↓</button>
                  <button aria-label={`Remove ${column.header}`} className="text-button" onClick={() => removeColumn(column.key)} type="button">Remove</button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {needsConfirmation && (
        <div className="roster-export-confirm status-chip gold">
          <p>
            This export shares {sensitiveChosen.map((column) => column.header).join(", ")}. Only share it with the
            camporee that needs it.
          </p>
          <label>
            <input
              checked={confirmSensitive}
              onChange={(event) => setConfirmSensitive(event.target.checked)}
              type="checkbox"
            />
            {" "}I understand and want to include {sensitiveChosen.map((column) => column.header).join(", ")}.
          </label>
        </div>
      )}

      {blockedByBirthDateAccess && (
        <p className="status-chip coral">Your club role doesn&apos;t include birth dates. Ask your club director.</p>
      )}

      {error && <p className="status-chip coral" role="alert">{error}</p>}
      {notice && <p className="status-chip green" role="status">{notice}</p>}

      <div className="form-actions">
        <button className="secondary-button" disabled={busy || !canRun} onClick={() => request("preview")} type="button">Preview</button>
        <button className="primary-button" disabled={busy || !canRun} onClick={() => request("csv")} type="button">Download CSV</button>
      </div>

      {preview && (
        <section aria-labelledby="roster-export-preview-heading">
          <h3 id="roster-export-preview-heading">
            Preview {preview.rows.length > PREVIEW_ROW_LIMIT ? `(first ${PREVIEW_ROW_LIMIT} of ${preview.rows.length})` : ""}
          </h3>
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>{preview.headers.map((header, index) => <th key={index}>{header}</th>)}</tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, PREVIEW_ROW_LIMIT).map((row, rowIndex) => (
                  <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <form className="roster-export-save-format" onSubmit={saveFormat}>
        <label htmlFor="roster-export-format-name">Save this column selection as a named format</label>
        <div className="roster-export-save-row">
          <input
            id="roster-export-format-name"
            maxLength={80}
            onChange={(event) => setFormatName(event.target.value)}
            placeholder="e.g. NAD Camporee"
            type="text"
            value={formatName}
          />
          <button className="secondary-button" disabled={busy || !formatName.trim() || columns.length === 0} type="submit">Save format</button>
        </div>
      </form>
    </div>
  );
}

function isRosterExportColumnValue(value: string): value is RosterExportColumnKey {
  return (ROSTER_EXPORT_COLUMN_KEYS as string[]).includes(value);
}
