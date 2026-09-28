"use client";

import { useCallback, useEffect, useState } from "react";
import { Car, ShieldCheck, ShieldX } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { formatIssueDate } from "@/modules/background-checks/issues";
import {
  DRIVER_EXPIRY_WARNING_DAYS,
  driverReasonLabels,
  type DriverClearanceStatus,
} from "@/modules/driver-verification/clearance";
import type { StaffDriverEntry } from "@/modules/driver-verification/repository";

/**
 * The staff driver exceptions queue (#544). Driver clearance comes from the
 * background-check list, so this lists only the willing drivers who need a
 * look: needs review, not cleared, or expiring within
 * `DRIVER_EXPIRY_WARNING_DAYS`. Cleared drivers are not here. Staff see the
 * issues text exactly as written, and can override one person with a note.
 * Clubs never render this: they get labels only.
 *
 * Every prop is a plain string: this is a Client Component rendered from a
 * Server Component page, and a function prop can't cross that boundary (it
 * throws at render). The per-person endpoint is built here from
 * `clearEndpointBase`.
 */

const statusLabel: Record<DriverClearanceStatus, string> = {
  CLEARED: "Cleared to drive",
  EXPIRING: "Expiring soon",
  NOT_CLEARED: "Not cleared",
  NEEDS_REVIEW: "Needs review",
};
const statusTone: Record<DriverClearanceStatus, string> = { CLEARED: "green", EXPIRING: "gold", NOT_CLEARED: "coral", NEEDS_REVIEW: "gold" };

export type DriverVerificationQueueProps = {
  listEndpoint: string;
  /** The override endpoint without the person: `${clearEndpointBase}/${personId}` is posted to. */
  clearEndpointBase: string;
};

export function clearEndpointFor(clearEndpointBase: string, personId: string) {
  return `${clearEndpointBase}/${encodeURIComponent(personId)}`;
}

function formatReviewedAt(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Chicago" });
}

/** One queue row. Kept hook-free so it renders on its own (tests render it statically). */
export function DriverQueueRow({
  entry,
  onReview,
}: {
  entry: StaffDriverEntry;
  onReview: (entry: StaffDriverEntry) => void;
}) {
  const { clearance, override } = entry;
  return (
    <tr>
      <th scope="row" translate="no">{entry.lastName}, {entry.firstName}</th>
      <td translate="no">{entry.organizationName}</td>
      <td>
        <span className={`status-chip ${statusTone[clearance.status]}`}>{statusLabel[clearance.status]}</span>
        {clearance.expiresOn && (
          <small className="quiet-copy">
            {" "}Expiring ({formatIssueDate(clearance.expiresOn)})
            {clearance.status === "EXPIRING" && clearance.warnStaff && `, within ${DRIVER_EXPIRY_WARNING_DAYS} days`}
          </small>
        )}
        {clearance.reasons.length > 0 && (
          <><br /><small className="quiet-copy">{clearance.reasons.map((reason) => driverReasonLabels[reason]).join("; ")}</small></>
        )}
      </td>
      <td>{entry.issuesText ? <span translate="no">{entry.issuesText}</span> : <span className="quiet-copy">None</span>}</td>
      <td>
        {override ? (
          <>
            <span className={`status-chip ${override.clearedToTransport ? "green" : "coral"}`}>
              {override.clearedToTransport
                ? <><ShieldCheck aria-hidden="true" size={12} /> Override: cleared</>
                : <><ShieldX aria-hidden="true" size={12} /> Override: not cleared</>}
            </span>
            <br />
            <small className="quiet-copy">
              {formatReviewedAt(override.reviewedAt)} by <span translate="no">{override.reviewerName}</span>
              {override.note && <>: <span translate="no">{override.note}</span></>}
            </small>
          </>
        ) : <span className="quiet-copy">None</span>}
      </td>
      <td>
        <button
          aria-label={`Override ${entry.firstName} ${entry.lastName}`}
          className="secondary-button"
          onClick={() => onReview(entry)}
          type="button"
        >
          Override
        </button>
      </td>
    </tr>
  );
}

export function DriverVerificationQueue({ listEndpoint, clearEndpointBase }: DriverVerificationQueueProps) {
  const [entries, setEntries] = useState<StaffDriverEntry[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewing, setReviewing] = useState<StaffDriverEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogOpen = reviewing !== null;
  const closeDialog = useCallback(() => setReviewing(null), []);
  const dialogRef = useAccessibleDialog<HTMLElement>(dialogOpen, closeDialog);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(listEndpoint);
      const result = await response.json().catch(() => ({})) as { entries?: StaffDriverEntry[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? "The driver exceptions could not be loaded.");
      setEntries(result.entries ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The driver exceptions could not be loaded.");
      setEntries([]);
    }
  }, [listEndpoint]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submitOverride(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewing) return;
    const form = new FormData(event.currentTarget);
    const clearedToTransport = form.get("outcome") === "cleared";
    const note = String(form.get("note") ?? "");
    setSaving(true);
    setError("");
    try {
      const response = await fetch(clearEndpointFor(clearEndpointBase, reviewing.personId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearedToTransport, note }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "The override could not be recorded.");
      setNotice(`Recorded: ${reviewing.firstName} ${reviewing.lastName} ${clearedToTransport ? "cleared" : "not cleared"} to drive.`);
      setReviewing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The override could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel driver-verification-queue">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Q1</p>
          <h2><Car aria-hidden="true" size={18} /> Driver exceptions</h2>
          <p>
            Driver clearance comes from the background-check list, so cleared drivers need no action and aren&apos;t
            listed. Here are the willing drivers who need review, aren&apos;t cleared, or expire within{" "}
            {DRIVER_EXPIRY_WARNING_DAYS} days. You can override one person, with a note; the override is audited.
          </p>
        </div>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {entries === null ? (
        <p className="report-empty">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="report-empty">No willing drivers need attention.</p>
      ) : (
        <div className="report-table-wrap">
          <table className="report-table">
            <caption className="sr-only">Willing drivers needing attention</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Club</th>
                <th scope="col">Clearance</th>
                <th scope="col">Issues column</th>
                <th scope="col">Override</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <DriverQueueRow entry={entry} key={entry.personId} onReview={setReviewing} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reviewing && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeDialog(); }} role="presentation">
          <section aria-labelledby="driver-review-title" aria-modal="true" className="modal-card" ref={dialogRef} role="dialog" tabIndex={-1}>
            <form className="form-stack" onSubmit={submitOverride}>
              <h2 id="driver-review-title" translate="no">{reviewing.firstName} {reviewing.lastName}</h2>
              <p>
                From the background-check list: <strong>{statusLabel[reviewing.clearance.status]}</strong>
                {reviewing.issuesText && <> — <span translate="no">{reviewing.issuesText}</span></>}
              </p>
              <fieldset className="form-grid">
                <legend>Override: cleared to drive?</legend>
                <label className="radio-label">
                  <input defaultChecked={reviewing.override?.clearedToTransport} name="outcome" required type="radio" value="cleared" /> Yes
                </label>
                <label className="radio-label">
                  <input defaultChecked={reviewing.override ? !reviewing.override.clearedToTransport : undefined} name="outcome" required type="radio" value="not-cleared" /> No
                </label>
              </fieldset>
              <label>
                Why (required)
                <textarea aria-describedby="driver-review-note-help" defaultValue={reviewing.override?.note ?? ""} maxLength={2000} name="note" required rows={3} />
                <small className="field-help" id="driver-review-note-help">Staff only. A club sees just the resulting status. Don&apos;t copy background-check details into it.</small>
              </label>
              <div className="form-actions">
                <button className="secondary-button" disabled={saving} onClick={closeDialog} type="button">Cancel</button>
                <button className="primary-button" disabled={saving} type="submit">Save override</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
