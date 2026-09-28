"use client";

import { useCallback, useEffect, useState } from "react";
import { Car, ShieldCheck, ShieldX } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { DriverQueueEntry } from "@/modules/driver-verification/repository";

/**
 * The driver verification queue (#491): every willing driver, their
 * background-check status and note, and a reviewer's decision. Used both by
 * a system administrator (every club) and by a club director or deputy
 * (their own club only) — the two pass different endpoints, never data.
 *
 * Every prop is a plain string or boolean: this is a Client Component
 * rendered from Server Component pages, and a function prop can't cross
 * that boundary (it throws at render). The per-person endpoint is built here
 * from `clearEndpointBase`.
 */

const complianceLabel = { CLEAR: "Clear", FLAGGED: "Expiring soon", NOT_COMPLIANT: "Not in compliance", NO_RECORD: "No record" } as const;
const complianceTone = { CLEAR: "green", FLAGGED: "gold", NOT_COMPLIANT: "coral", NO_RECORD: "gold" } as const;

export type DriverVerificationQueueProps = {
  listEndpoint: string;
  /** The decision endpoint without the person: `${clearEndpointBase}/${personId}` is posted to. */
  clearEndpointBase: string;
  /** The admin queue spans every club, so it shows which one each row is on. */
  showClub?: boolean;
};

export function clearEndpointFor(clearEndpointBase: string, personId: string) {
  return `${clearEndpointBase}/${encodeURIComponent(personId)}`;
}

/**
 * Previously cleared, but the background check on file today isn't Clear
 * (expiring, not in compliance, or gone): the old decision no longer stands
 * on its own, so the queue asks for a fresh look.
 */
export function needsReReview(entry: Pick<DriverQueueEntry, "backgroundCheck" | "verification">) {
  return Boolean(entry.verification?.clearedToTransport) && entry.backgroundCheck.state !== "CLEAR";
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
  showClub,
  onReview,
}: {
  entry: DriverQueueEntry;
  showClub: boolean;
  onReview: (entry: DriverQueueEntry) => void;
}) {
  const reReview = needsReReview(entry);
  return (
    <tr>
      <th scope="row" translate="no">{entry.lastName}, {entry.firstName}</th>
      {showClub && <td translate="no">{entry.organizationName}</td>}
      <td>
        <span className={`status-chip ${complianceTone[entry.backgroundCheck.state]}`}>
          {complianceLabel[entry.backgroundCheck.state]}
        </span>
        {entry.backgroundCheck.note && <><br /><small className="quiet-copy">{entry.backgroundCheck.note}</small></>}
      </td>
      <td>
        {entry.verification ? (
          <>
            {reReview ? (
              <span className="status-chip gold">Needs re-review</span>
            ) : (
              <span className={`status-chip ${entry.verification.clearedToTransport ? "green" : "coral"}`}>
                {entry.verification.clearedToTransport
                  ? <><ShieldCheck aria-hidden="true" size={12} /> Cleared</>
                  : <><ShieldX aria-hidden="true" size={12} /> Not cleared</>}
              </span>
            )}
            <br />
            <small className="quiet-copy">
              {reReview ? "Cleared" : "Reviewed"} {formatReviewedAt(entry.verification.reviewedAt)} by{" "}
              <span translate="no">{entry.verification.reviewerName}</span>
            </small>
          </>
        ) : <span className="status-chip gold">Needs review</span>}
      </td>
      <td>
        <button
          aria-label={`Review ${entry.firstName} ${entry.lastName}`}
          className="secondary-button"
          onClick={() => onReview(entry)}
          type="button"
        >
          Review
        </button>
      </td>
    </tr>
  );
}

export function DriverVerificationQueue({
  listEndpoint,
  clearEndpointBase,
  showClub = false,
}: DriverVerificationQueueProps) {
  const [entries, setEntries] = useState<DriverQueueEntry[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewing, setReviewing] = useState<DriverQueueEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogOpen = reviewing !== null;
  const closeDialog = useCallback(() => setReviewing(null), []);
  const dialogRef = useAccessibleDialog<HTMLElement>(dialogOpen, closeDialog);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(listEndpoint);
      const result = await response.json().catch(() => ({})) as { entries?: DriverQueueEntry[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? "The driver verification queue could not be loaded.");
      setEntries(result.entries ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The driver verification queue could not be loaded.");
      setEntries([]);
    }
  }, [listEndpoint]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submitReview(event: React.FormEvent<HTMLFormElement>) {
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
        body: JSON.stringify({ clearedToTransport, note, confirmedChecksReviewed: true }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "The decision could not be recorded.");
      setNotice(`Recorded: ${reviewing.firstName} ${reviewing.lastName} ${clearedToTransport ? "cleared" : "not cleared"} to transport youth.`);
      setReviewing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The decision could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel driver-verification-queue">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Q1</p>
          <h2><Car aria-hidden="true" size={18} /> Driver verification queue</h2>
          <p>
            Everyone who checked &quot;Willing to drive&quot; on their roster profile. Checking the box never clears
            anyone — confirm their license, insurance, and background-check status yourself, then record the outcome.
          </p>
        </div>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {entries === null ? (
        <p className="report-empty">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="report-empty">No one has checked &quot;Willing to drive&quot; yet.</p>
      ) : (
        <div className="report-table-wrap">
          <table className="report-table">
            <caption className="sr-only">Willing drivers</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                {showClub && <th scope="col">Club</th>}
                <th scope="col">Background check</th>
                <th scope="col">Review</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <DriverQueueRow entry={entry} key={entry.personId} onReview={setReviewing} showClub={showClub} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reviewing && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeDialog(); }} role="presentation">
          <section aria-labelledby="driver-review-title" aria-modal="true" className="modal-card" ref={dialogRef} role="dialog" tabIndex={-1}>
            <form className="form-stack" onSubmit={submitReview}>
              <h2 id="driver-review-title" translate="no">{reviewing.firstName} {reviewing.lastName}</h2>
              <p>
                Background check: <strong>{complianceLabel[reviewing.backgroundCheck.state]}</strong>
                {reviewing.backgroundCheck.note && ` — ${reviewing.backgroundCheck.note}`}
              </p>
              <label className="checkbox-label">
                <input name="confirm" required type="checkbox" />
                I checked this person&apos;s license, insurance, and background-check status.
              </label>
              <fieldset className="form-grid">
                <legend>Cleared to transport youth?</legend>
                <label className="radio-label">
                  <input defaultChecked={reviewing.verification?.clearedToTransport} name="outcome" required type="radio" value="cleared" /> Yes
                </label>
                <label className="radio-label">
                  <input defaultChecked={reviewing.verification ? !reviewing.verification.clearedToTransport : undefined} name="outcome" required type="radio" value="not-cleared" /> No
                </label>
              </fieldset>
              <label>
                Note
                <textarea defaultValue={reviewing.verification?.note ?? ""} maxLength={2000} name="note" rows={3} />
              </label>
              <div className="form-actions">
                <button className="secondary-button" disabled={saving} onClick={closeDialog} type="button">Cancel</button>
                <button className="primary-button" disabled={saving} type="submit">Save decision</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
