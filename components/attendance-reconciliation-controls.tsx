"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/**
 * Staff controls for the Attendance reconciliation screen (#166). Every action posts to one
 * endpoint that checks MANAGE_FINANCE for the event again; hiding a control is never the
 * protection. Nothing here finalizes or sends an invoice.
 */

async function postAction(eventId: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/attendance-reconciliation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : "The change could not be saved.");
  return result as Record<string, unknown>;
}

function useAction(eventId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run(body: Record<string, unknown>, summarize?: (result: Record<string, unknown>) => string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await postAction(eventId, body);
      if (summarize) setNotice(summarize(result));
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run };
}

export function PrepareControl({ eventId, disabled, disabledReason }: { eventId: string; disabled: boolean; disabledReason?: string }) {
  const { busy, error, notice, run } = useAction(eventId);
  return (
    <span className="billing-inline-action">
      <button
        className="primary-button"
        disabled={busy || disabled}
        onClick={() => void run({ action: "prepare" }, (result) => (result.created ? "Draft prepared." : "Nothing has changed since the last version, so no new draft was made."))}
        title={disabled ? disabledReason : undefined}
        type="button"
      >
        {busy ? "Preparing…" : "Prepare reconciliation"}
      </button>
      {notice && <small role="status">{notice}</small>}
      {error && <small className="form-error" role="alert">{error}</small>}
    </span>
  );
}

export function ApproveControl({ eventId, versionId, versionNumber, disabled }: { eventId: string; versionId: string; versionNumber: number; disabled?: boolean }) {
  const { busy, error, run } = useAction(eventId);
  return (
    <span className="billing-inline-action">
      <button
        className="primary-button"
        disabled={busy || disabled}
        onClick={() => void run({ action: "approve", versionId })}
        type="button"
      >
        {busy ? "Approving…" : `Approve version ${versionNumber}`}
      </button>
      {error && <small className="form-error" role="alert">{error}</small>}
    </span>
  );
}

export const ARRIVAL_PRORATE_WARNING = "Someone was transferred in. Prorating bills them on this registration's own estimate, which does not include them.";

export const PRORATE_NOTE = "Prorating scales the whole registration's estimate, including charges that are not tied to a person, by attended over registered.";

export const REASON_HELP = "Don't include health or medical details. A short reason like 'did not attend' or 'missed at check-in' is enough.";

function dollars(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * Staff choose which figure to bill for a registration whose prices cannot be matched to people with
 * certainty: the per-person best match or the prorated estimate. A reason is required.
 */
export function AcknowledgeForm({
  eventId,
  registrationId,
  alternatives,
  hasArrival = false,
  changing = false,
}: {
  eventId: string;
  registrationId: string;
  alternatives: { perPersonCents: number; proratedCents: number } | null;
  /** Someone was transferred in: prorating bills them on the receiving registration's own estimate. */
  hasArrival?: boolean;
  /** An acknowledgement already exists; a different choice or reason supersedes it. */
  changing?: boolean;
}) {
  const { busy, error, run } = useAction(eventId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [choice, setChoice] = useState<"PER_PERSON" | "PRORATED">("PRORATED");
  const reasonId = useId();
  if (!open) {
    return <button className="secondary-button" onClick={() => setOpen(true)} type="button">{changing ? "Change choice…" : "Acknowledge…"}</button>;
  }
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run({ action: "acknowledge", registrationId, choice, reason }).then((ok) => {
          if (ok) setOpen(false);
        });
      }}
    >
      {alternatives && (
        <fieldset>
          <legend>Which figure should be billed?</legend>
          <label><input checked={choice === "PER_PERSON"} name={`choice-${registrationId}`} onChange={() => setChoice("PER_PERSON")} type="radio" /> Per-person (best match): {dollars(alternatives.perPersonCents)}</label>
          <label><input checked={choice === "PRORATED"} name={`choice-${registrationId}`} onChange={() => setChoice("PRORATED")} type="radio" /> Prorated: {dollars(alternatives.proratedCents)}</label>
          <small>{PRORATE_NOTE}</small>
          {hasArrival && choice === "PRORATED" && <small role="alert">{ARRIVAL_PRORATE_WARNING}</small>}
        </fieldset>
      )}
      <label htmlFor={reasonId}>{choice === "PER_PERSON" ? "Why did you choose the per-person figure?" : "Why did you choose the prorated figure?"}</label>
      <textarea aria-describedby={`${reasonId}-help`} id={reasonId} maxLength={500} onChange={(event) => setReason(event.target.value)} required rows={2} value={reason} />
      <small id={`${reasonId}-help`}>{REASON_HELP}</small>
      <span className="billing-inline-action">
        <button className="primary-button" disabled={busy || reason.trim() === ""} type="submit">{busy ? "Saving…" : changing ? "Save choice" : "Acknowledge"}</button>
        <button className="secondary-button" onClick={() => setOpen(false)} type="button">Cancel</button>
      </span>
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}

/** Mark a person attended or not attended, or withdraw an earlier correction. A reason is required. */
export function CorrectionForm({
  eventId,
  attendeeId,
  personName,
  attended,
  hasCorrection,
}: {
  eventId: string;
  attendeeId: string;
  personName: string;
  attended: boolean;
  hasCorrection: boolean;
}) {
  const { busy, error, run } = useAction(eventId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const kind = attended ? "MARK_NOT_ATTENDED" : "MARK_ATTENDED";
  if (!open) {
    return <button className="secondary-button" onClick={() => setOpen(true)} type="button">Correct…</button>;
  }
  async function submit(chosen: "MARK_ATTENDED" | "MARK_NOT_ATTENDED" | "CLEAR") {
    const ok = await run({ action: "correct", attendeeId, kind: chosen, reason });
    if (ok) {
      setOpen(false);
      setReason("");
    }
  }
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(kind);
      }}
    >
      <label htmlFor={reasonId}>Why are you correcting {personName}?</label>
      <textarea aria-describedby={`${reasonId}-help`} id={reasonId} maxLength={500} onChange={(event) => setReason(event.target.value)} required rows={2} value={reason} />
      <small id={`${reasonId}-help`}>{REASON_HELP}</small>
      <span className="billing-inline-action">
        <button className="primary-button" disabled={busy || reason.trim() === ""} type="submit">
          {busy ? "Saving…" : attended ? "Mark not attended" : "Mark attended"}
        </button>
        {hasCorrection && (
          <button className="secondary-button" disabled={busy || reason.trim() === ""} onClick={() => void submit("CLEAR")} type="button">
            Withdraw correction
          </button>
        )}
        <button className="secondary-button" onClick={() => setOpen(false)} type="button">Cancel</button>
      </span>
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}
