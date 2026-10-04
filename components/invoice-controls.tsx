"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/**
 * Staff controls for the Invoices screens (#167). Every action posts to one endpoint that checks
 * MANAGE_FINANCE for the event again (and Finalize invoices for what changes an amount); hiding a
 * control is never the protection. Finalizing is deliberate: a named confirmation, never automatic,
 * and nothing here sends an invoice (#168).
 */

async function postAction(eventId: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/invoices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : "The change could not be saved.");
  return result as Record<string, unknown>;
}

function useAction(eventId: string, onDone?: (result: Record<string, unknown>) => void) {
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
      onDone?.(result);
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

export function CreateDraftsControl({ eventId, disabled, disabledReason }: { eventId: string; disabled: boolean; disabledReason?: string }) {
  const { busy, error, notice, run } = useAction(eventId);
  return (
    <span className="billing-inline-action">
      <button
        className="primary-button"
        disabled={busy || disabled}
        onClick={() => void run({ action: "create-drafts" }, (result) => {
          const created = Number(result.created ?? 0);
          const regenerated = Number(result.regenerated ?? 0);
          const needRevision = Number(result.needRevision ?? 0);
          const parts = [`${created} new ${created === 1 ? "draft" : "drafts"}`, `${regenerated} refreshed`];
          if (needRevision > 0) parts.push(`${needRevision} finalized ${needRevision === 1 ? "invoice needs" : "invoices need"} a revision`);
          return `Done: ${parts.join(", ")}.`;
        })}
        title={disabled ? disabledReason : undefined}
        type="button"
      >
        {busy ? "Creating…" : "Create invoice drafts"}
      </button>
      {notice && <small role="status">{notice}</small>}
      {error && <small className="form-error" role="alert">{error}</small>}
    </span>
  );
}

export function RegenerateControl({ eventId, invoiceId }: { eventId: string; invoiceId: string }) {
  const { busy, error, run } = useAction(eventId);
  return (
    <span className="billing-inline-action">
      <button className="secondary-button" disabled={busy} onClick={() => void run({ action: "regenerate", invoiceId })} type="button">
        {busy ? "Regenerating…" : "Regenerate draft"}
      </button>
      {error && <small className="form-error" role="alert">{error}</small>}
    </span>
  );
}

export function DiscardControl({ eventId, invoiceId, isRevision }: { eventId: string; invoiceId: string; isRevision: boolean }) {
  const router = useRouter();
  const { busy, error, run } = useAction(eventId);
  return (
    <span className="billing-inline-action">
      <button
        className="secondary-button"
        disabled={busy}
        onClick={() => {
          if (!window.confirm(isRevision ? "Discard this revision draft? The finalized invoice stays as it is." : "Discard this draft? You can create a fresh one from the approved reconciliation.")) return;
          void run({ action: "discard", invoiceId }).then((ok) => { if (ok && !isRevision) router.push(`/finance/invoices?event=${encodeURIComponent(eventId)}`); });
        }}
        type="button"
      >
        {busy ? "Discarding…" : "Discard draft"}
      </button>
      {error && <small className="form-error" role="alert">{error}</small>}
    </span>
  );
}

export function ReviseForm({
  eventId,
  invoiceId,
  contactChanged,
  amountsOutOfDate,
}: {
  eventId: string;
  invoiceId: string;
  contactChanged: boolean;
  amountsOutOfDate: boolean;
}) {
  const [mode, setMode] = useState<"CONTACT_ONLY" | "FROM_RECONCILIATION">(contactChanged && !amountsOutOfDate ? "CONTACT_ONLY" : "FROM_RECONCILIATION");
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const { busy, error, run } = useAction(eventId);
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run({ action: "revise", invoiceId, mode, reason });
      }}
    >
      <label>
        What to revise
        <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="CONTACT_ONLY">The billing contact only (amounts stay the same)</option>
          <option value="FROM_RECONCILIATION">Rebuild the amounts from the approved reconciliation</option>
        </select>
      </label>
      <label htmlFor={reasonId}>
        Why
        <textarea id={reasonId} maxLength={500} onChange={(event) => setReason(event.target.value)} required rows={2} value={reason} />
      </label>
      <small>
        {mode === "CONTACT_ONLY"
          ? "A contact-only revision can be finalized by finance staff. The finalized invoice stays readable."
          : "A revision that changes an amount can be finalized only by someone with permission to finalize invoices. The finalized invoice stays readable."}
      </small>
      <span className="billing-inline-action">
        <button className="secondary-button" disabled={busy || reason.trim() === ""} type="submit">{busy ? "Starting…" : "Start a revision"}</button>
      </span>
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}

export function FinalizeControl({
  eventId,
  versionId,
  label,
  amountLabel,
  viewerName,
  revision,
}: {
  eventId: string;
  versionId: string;
  /** What the person is approving, for the confirmation sentence. */
  label: string;
  amountLabel: string;
  viewerName: string;
  revision: number;
}) {
  // One key per page view, reused if the request is retried, so a retry returns the same number.
  const [key] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `finalize-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  const [confirmed, setConfirmed] = useState(false);
  const [number, setNumber] = useState("");
  const { busy, error, run } = useAction(eventId, (result) => setNumber(typeof result.number === "string" ? result.number : ""));
  const confirmId = useId();
  return (
    <div className="invoice-confirm">
      <label htmlFor={confirmId}>
        <input checked={confirmed} id={confirmId} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
        <span>
          I, {viewerName}, approve {revision === 0 ? "this invoice" : `revision ${revision} of this invoice`} for {label} totaling {amountLabel}.
          Finalizing assigns the invoice number and cannot be undone; later corrections are made as a revision. Nothing is sent to anyone.
        </span>
      </label>
      <span className="billing-inline-action">
        <button
          className="primary-button"
          disabled={busy || !confirmed}
          onClick={() => void run({ action: "finalize", versionId, idempotencyKey: key, confirm: true })}
          type="button"
        >
          {busy ? "Finalizing…" : "Finalize invoice"}
        </button>
        {number && <small role="status">Finalized as {number}.</small>}
      </span>
      {error && <small className="form-error" role="alert">{error}</small>}
    </div>
  );
}

export function InvoiceCodeForm({ eventId, explicit, effective, locked, year }: { eventId: string; explicit: string | null; effective: string; locked: boolean; year: number }) {
  const [code, setCode] = useState(explicit ?? "");
  const { busy, error, notice, run } = useAction(eventId);
  const yy = String(year % 100).padStart(2, "0");
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run({ action: "set-code", code: code.trim() === "" ? null : code }, () => "Saved.");
      }}
    >
      <label>
        Invoice number code
        <input disabled={locked || busy} maxLength={6} onChange={(event) => setCode(event.target.value.toUpperCase())} pattern="[A-Za-z]{2,6}" placeholder={effective} value={code} />
      </label>
      <small>
        Numbers look like {effective}{yy}-0001. {locked ? "Numbers were already issued for this event, so the code is locked." : "Leave it blank to use the code made from the event name. It locks when the first invoice is finalized."}
      </small>
      {!locked && (
        <span className="billing-inline-action">
          <button className="secondary-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save code"}</button>
          {notice && <small role="status">{notice}</small>}
        </span>
      )}
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}
