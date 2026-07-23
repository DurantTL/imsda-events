"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileCheck2, FileUp, History, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";

type ImportRecordView = {
  id: string;
  sourceRow: number;
  sourceRecordKey: string;
  confirmationCode: string;
  status: string;
  proposedAction: string;
  normalizedData: { firstName: string; lastName: string; email: string; totalAmountCents: number; status: string } | null;
  differences: unknown[];
  warnings: string[];
  errors: string[];
};

type ImportRunView = {
  id: string;
  fileName: string;
  sourceChecksum: string;
  status: string;
  recordsCreated: number;
  recordsUpdated: number;
  recordsSkipped: number;
  warnings: number;
  errors: number;
  summary: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
  startedBy: string;
  records: ImportRecordView[];
};

type ReconciliationView = {
  target: { registrations: number; attendees: number; totalAmountCents: number };
  latestRun: { id: string; fileName: string; completedAt: string | null; summary: Record<string, unknown> } | null;
};

type ImportDifference = {
  field: string;
  source: string | number | null;
  target: string | number | null;
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function sourceTotals(run: ImportRunView | null) {
  const value = run?.summary.sourceTotals;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as { rows?: number; totalAmountCents?: number }
    : {};
}

function actionTone(action: string) {
  if (action === "CREATE" || action === "CREATED") return "green";
  if (action === "UPDATE" || action === "UPDATED") return "gold";
  if (action === "ERROR") return "coral";
  return "purple";
}

function differenceLabel(field: string) {
  const labels: Record<string, string> = {
    firstName: "First name",
    lastName: "Last name",
    email: "Email",
    phone: "Phone",
    status: "Registration status",
    totalAmountCents: "Registration total",
    submittedAt: "Submitted date",
    attendeeType: "Attendee type",
  };
  return labels[field] ?? field.replaceAll("_", " ");
}

function differenceValue(
  field: string,
  value: string | number | null,
) {
  if (value === null || value === "") return "Not set";
  if (field === "totalAmountCents" && typeof value === "number") return money(value);
  if (field === "submittedAt" && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toLocaleString();
  }
  return String(value);
}

function importDifferences(values: unknown[]): ImportDifference[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const difference = value as Record<string, unknown>;
    if (typeof difference.field !== "string") return [];
    const validValue = (candidate: unknown): candidate is string | number | null => (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "number"
    );
    if (!validValue(difference.source) || !validValue(difference.target)) return [];
    return [{
      field: difference.field,
      source: difference.source,
      target: difference.target,
    }];
  });
}

export function ImportWorkspace({ eventId, eventName, initialRuns, initialReconciliation }: { eventId: string; eventName: string; initialRuns: ImportRunView[]; initialReconciliation: ReconciliationView }) {
  const [runs, setRuns] = useState(initialRuns);
  const [selected, setSelected] = useState<ImportRunView | null>(initialRuns.find((run) => run.status === "PENDING") ?? null);
  const [reconciliation, setReconciliation] = useState(initialReconciliation);
  const [file, setFile] = useState<File | null>(null);
  const [filter, setFilter] = useState("ALL");
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmDialogRef = useAccessibleDialog<HTMLElement>(
    confirming,
    () => {
      if (!busy) setConfirming(false);
    },
  );

  const visibleRecords = useMemo(() => (selected?.records ?? []).filter((record) => {
    if (filter === "ALL") return true;
    if (filter === "ISSUES") return record.errors.length > 0 || record.warnings.length > 0;
    return record.proposedAction === filter || record.status === filter;
  }), [selected, filter]);
  const actionCounts = useMemo(() => (selected?.records ?? []).reduce((counts, record) => {
    counts[record.proposedAction] = (counts[record.proposedAction] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>), [selected]);
  const visibleChanges = useMemo(() => visibleRecords.flatMap((record) => {
    const differences = importDifferences(record.differences);
    return differences.length > 0 ? [{ record, differences }] : [];
  }), [visibleRecords]);
  const selectedSourceTotals = sourceTotals(selected);

  async function refreshReconciliation() {
    const response = await fetch(`/api/events/${eventId}/imports/reconciliation`);
    if (response.ok) setReconciliation(await response.json());
  }

  async function preview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) { setError("Choose a CSV file first."); return; }
    setBusy("preview"); setError(""); setNotice("");
    const payload = new FormData();
    payload.set("file", file);
    try {
      const response = await fetch(`/api/events/${eventId}/imports/preview`, { method: "POST", body: payload });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to preview this CSV.");
      const run = result.run as ImportRunView;
      setSelected(run);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setFilter("ALL");
      setNotice(result.reused ? "This exact file was already previewed, so its existing idempotent run was reopened." : "Preview created. Review every issue and proposed action before committing.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to preview this CSV.");
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!selected) return;
    setBusy("commit"); setError(""); setNotice(""); setConfirming(false);
    try {
      const response = await fetch(`/api/events/${eventId}/imports/${selected.id}/commit`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to commit this import.");
      const run = result.run as ImportRunView;
      setSelected(run);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      await refreshReconciliation();
      setNotice(`Import completed: ${run.recordsCreated} created, ${run.recordsUpdated} updated, and ${run.recordsSkipped} unchanged.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to commit this import.");
    } finally {
      setBusy(null);
    }
  }

  function selectRun(run: ImportRunView) {
    setSelected(run); setFilter("ALL"); setError(""); setNotice("");
  }

  return <section className="page-stack import-workspace">
    <div className="page-intro"><div><p className="eyebrow">Build 5 staging</p><h2>Import & reconcile</h2><p>Preview a CSV snapshot, inspect matching decisions, and commit validated records to {eventName} locally.</p></div><span className="count-badge"><ShieldCheck size={16} /> Read-only source</span></div>

    <div className="import-top-grid">
      <section className="panel import-upload-panel"><div className="section-heading"><div><p className="eyebrow">Step 1</p><h2>Choose a source snapshot</h2></div><FileUp size={21} /></div><p className="quiet-copy">Required columns: source ID, confirmation code, name, and total amount. Up to 2,000 rows or 2 MB.</p><form className="import-upload-form" onSubmit={preview}><label className={file ? "file-drop selected" : "file-drop"}><input ref={inputRef} type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><FileCheck2 size={24} /><span><strong>{file?.name ?? "Choose a CSV file"}</strong><small>{file ? `${Math.max(1, Math.round(file.size / 1024))} KB ready to preview` : "Click to browse local files"}</small></span></label><div className="template-links"><a href="/fixtures/wr26-import-template.csv" download><Download size={14} /> CSV template</a><a href="/fixtures/wr26-import-sample.csv" download><Download size={14} /> Fictitious sample</a></div><button className="primary-button full-button" type="submit" disabled={busy !== null}>{busy === "preview" ? <><RefreshCw className="spin" size={16} /> Validating and matching…</> : <><FileCheck2 size={16} /> Preview import</>}</button></form></section>

      <section className="panel reconciliation-panel"><div className="section-heading"><div><p className="eyebrow">Live local database</p><h2>Reconciliation totals</h2></div></div><div className="reconciliation-grid"><span><small>Registrations</small><strong>{reconciliation.target.registrations}</strong></span><span><small>Attendees</small><strong>{reconciliation.target.attendees}</strong></span><span><small>Registration value</small><strong>{money(reconciliation.target.totalAmountCents)}</strong></span></div>{reconciliation.latestRun ? <p className="reconciliation-note"><CheckCircle2 size={15} /> Last committed: {reconciliation.latestRun.fileName} · {reconciliation.latestRun.completedAt ? new Date(reconciliation.latestRun.completedAt).toLocaleString() : "complete"}</p> : <p className="reconciliation-note muted">No staging import has been committed yet.</p>}<div className="boundary-callout"><ShieldCheck size={18} /><span><strong>Production boundary intact</strong><small>No Google Sheets, Apps Script, payment, or legacy-system write is performed.</small></span></div></section>
    </div>

    {error && <div className="inline-notice error" role="alert">{error}</div>}
    {notice && <div className="inline-notice" role="status">{notice}</div>}

    {selected && visibleChanges.length > 0 && (
      <section className="panel import-change-review">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Review before importing</p>
            <h2>Exactly what will change</h2>
            <p>Current values are shown beside the values from the CSV file.</p>
          </div>
        </div>
        <div className="import-change-list">
          {visibleChanges.map(({ record, differences }) => (
            <details key={record.id}>
              <summary>
                Row {record.sourceRow} · {record.confirmationCode || record.sourceRecordKey}
                <span>{differences.length} change{differences.length === 1 ? "" : "s"}</span>
              </summary>
              <dl>
                {differences.map((difference) => (
                  <div key={difference.field}>
                    <dt>{differenceLabel(difference.field)}</dt>
                    <dd><small>Current</small>{differenceValue(difference.field, difference.target)}</dd>
                    <dd><small>From CSV</small>{differenceValue(difference.field, difference.source)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </div>
      </section>
    )}

    {selected && <section className="panel import-preview"><div className="import-preview-head"><div><p className="eyebrow">Step 2 · {selected.status.toLowerCase()}</p><h2>{selected.fileName}</h2><p>Checksum {selected.sourceChecksum.slice(0, 12)}… · uploaded by {selected.startedBy}</p></div><div className="preview-actions">{(selected.warnings > 0 || selected.errors > 0) && <a className="secondary-button" href={`/api/events/${eventId}/imports/${selected.id}/exceptions`}><Download size={15} /> Exceptions</a>}{selected.status === "PENDING" && <button className="primary-button" type="button" disabled={selected.errors > 0 || busy !== null} onClick={() => setConfirming(true)}><CheckCircle2 size={16} /> Commit import</button>}</div></div><div className="import-stats"><span><small>Source rows</small><strong>{selectedSourceTotals.rows ?? selected.records.length}</strong></span><span className="green"><small>Create</small><strong>{actionCounts.CREATE ?? selected.recordsCreated}</strong></span><span className="gold"><small>Update</small><strong>{actionCounts.UPDATE ?? selected.recordsUpdated}</strong></span><span className="purple"><small>Unchanged</small><strong>{actionCounts.SKIP ?? selected.recordsSkipped}</strong></span><span className={selected.errors ? "coral" : "green"}><small>Errors</small><strong>{selected.errors}</strong></span><span className={selected.warnings ? "gold" : "green"}><small>Warnings</small><strong>{selected.warnings}</strong></span></div>{selected.errors > 0 && <div className="import-blocked"><AlertTriangle size={18} /><span><strong>Commit blocked</strong><small>Correct the source CSV and upload the revised snapshot. A new checksum will create a new preview.</small></span></div>}<div className="import-filters"><button className={filter === "ALL" ? "active" : ""} type="button" onClick={() => setFilter("ALL")}>All</button><button className={filter === "CREATE" ? "active" : ""} type="button" onClick={() => setFilter("CREATE")}>Creates</button><button className={filter === "UPDATE" ? "active" : ""} type="button" onClick={() => setFilter("UPDATE")}>Updates</button><button className={filter === "SKIP" ? "active" : ""} type="button" onClick={() => setFilter("SKIP")}>Unchanged</button><button className={filter === "ISSUES" ? "active" : ""} type="button" onClick={() => setFilter("ISSUES")}>Issues</button></div><div className="import-table"><div className="import-row import-head"><span>Row / source</span><span>Registration</span><span>Person</span><span>Decision</span><span>Issues</span></div>{visibleRecords.slice(0, 100).map((record) => <article className="import-row" key={record.id}><span><strong>Row {record.sourceRow}</strong><small>{record.sourceRecordKey}</small></span><span><strong>{record.confirmationCode || "Missing"}</strong><small>{record.normalizedData?.status?.toLowerCase() ?? "invalid"}</small></span><span><strong>{record.normalizedData ? `${record.normalizedData.firstName} ${record.normalizedData.lastName}` : "Invalid row"}</strong><small>{record.normalizedData?.email || "No email"}</small></span><span><span className={`status-chip ${actionTone(record.status === "READY" || record.status === "WARNING" ? record.proposedAction : record.status)}`}>{record.status === "READY" || record.status === "WARNING" ? record.proposedAction.toLowerCase() : record.status.toLowerCase()}</span><small>{record.differences.length > 0 ? `${record.differences.length} field changes` : "No field changes"}</small></span><span>{record.errors.map((issue) => <small className="issue error" key={issue}>{issue}</small>)}{record.warnings.map((issue) => <small className="issue warning" key={issue}>{issue}</small>)}{record.errors.length === 0 && record.warnings.length === 0 && <small className="issue clear">Ready</small>}</span></article>)}</div>{visibleRecords.length > 100 && <p className="result-summary">Showing the first 100 of {visibleRecords.length} matching rows.</p>}</section>}

    <section className="panel import-history"><div className="section-heading"><div><p className="eyebrow">Import audit</p><h2>Run history</h2></div><span className="count-badge"><History size={15} /> {runs.length} runs</span></div><div className="history-list">{runs.map((run) => <button className={selected?.id === run.id ? "history-row selected" : "history-row"} type="button" key={run.id} onClick={() => selectRun(run)}><span className={`history-icon ${run.status.toLowerCase()}`}>{run.status === "COMPLETED" ? <CheckCircle2 size={17} /> : <FileCheck2 size={17} />}</span><span><strong>{run.fileName}</strong><small>{run.startedBy} · {new Date(run.startedAt).toLocaleString()}</small></span><span><strong>{run.status.toLowerCase()}</strong><small>{run.recordsCreated} created · {run.recordsUpdated} updated · {run.recordsSkipped} skipped</small></span></button>)}</div></section>

    {confirming && selected && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirming(false); }}><section className="modal-card confirm-import-modal" ref={confirmDialogRef} role="dialog" aria-modal="true" aria-labelledby="confirm-import-title" tabIndex={-1}><div className="modal-head"><div><p className="eyebrow">Final local write</p><h2 id="confirm-import-title">Commit this staging import?</h2></div><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setConfirming(false)}><X size={18} /></button></div><div className="boundary-callout"><ShieldCheck size={19} /><span><strong>Local IMSDA Events database only</strong><small>The source file and all external systems remain read-only.</small></span></div><p className="confirm-copy">This will apply {actionCounts.CREATE ?? 0} creates, {actionCounts.UPDATE ?? 0} updates, and {actionCounts.SKIP ?? 0} unchanged rows. The run and every row decision remain in import history.</p><div className="form-actions"><button className="secondary-button" type="button" onClick={() => setConfirming(false)}>Review again</button><button className="primary-button" type="button" disabled={busy !== null} onClick={commit}>{busy === "commit" ? "Committing…" : "Commit local import"}</button></div></section></div>}
  </section>;
}
