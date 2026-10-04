"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { RecipientCandidate } from "@/modules/invoices/delivery-domain";

/**
 * Staff controls for sending an invoice, marking it posted to AR, and recording payments (#168). Each posts to an
 * endpoint that checks MANAGE_FINANCE for the event again; hiding a control is never the protection. Nothing here
 * runs on its own: every send, posting and payment is a deliberate click by a named staff member.
 */

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `key-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function post(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : "The change could not be saved.");
  return result as Record<string, unknown>;
}

function useLedgerAction(eventId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run(body: Record<string, unknown>, summarize?: (result: Record<string, unknown>) => string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await post(`/api/events/${encodeURIComponent(eventId)}/invoices/ledger`, body);
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

const today = () => new Date().toISOString().slice(0, 10);

export function PostToArForm({ eventId, versionId, posted }: { eventId: string; versionId: string; posted: { postedOn: string; reference: string | null } | null }) {
  const [date, setDate] = useState(posted?.postedOn ?? today());
  const [reference, setReference] = useState(posted?.reference ?? "");
  const [reason, setReason] = useState("");
  const { busy, error, notice, run } = useLedgerAction(eventId);
  const correcting = posted !== null;
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          correcting
            ? { action: "correct-ar", versionId, postedOn: date, reference: reference.trim() || null, reason }
            : { action: "post-to-ar", versionId, postedOn: date, reference: reference.trim() || null },
          () => (correcting ? "Correction saved." : "Marked as posted to AR."),
        );
      }}
    >
      <label>
        Posted on
        <input onChange={(event) => setDate(event.target.value)} required type="date" value={date} />
      </label>
      <label>
        Reference in your books (optional)
        <input maxLength={80} onChange={(event) => setReference(event.target.value)} value={reference} />
      </label>
      {correcting && (
        <label>
          Why you are correcting it
          <input maxLength={300} onChange={(event) => setReason(event.target.value)} required value={reason} />
        </label>
      )}
      <span className="billing-inline-action">
        <button className="secondary-button" disabled={busy || (correcting && reason.trim() === "")} type="submit">
          {busy ? "Saving…" : correcting ? "Correct the posting" : "Mark posted to AR"}
        </button>
        {notice && <small role="status">{notice}</small>}
      </span>
      {correcting && <small>The earlier posting stays on record; a correction is a new entry.</small>}
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}

export function RecordPaymentForm({ eventId, invoiceId }: { eventId: string; invoiceId: string }) {
  const [amount, setAmount] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [receivedOn, setReceivedOn] = useState(today());
  const [note, setNote] = useState("");
  // One key per form fill, reused if the request is retried, so a double click records one payment.
  const [key, setKey] = useState(newKey);
  const { busy, error, notice, run } = useLedgerAction(eventId);
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run({ action: "record-payment", invoiceId, amount, checkNumber: checkNumber.trim() || null, receivedOn, note: note.trim() || null, requestKey: key }, (result) =>
          Number(result.overpaidCents ?? 0) > 0 ? "Recorded. This is more than the invoice total, so it shows as overpaid." : "Payment recorded.").then((ok) => {
          if (ok) {
            setAmount("");
            setCheckNumber("");
            setNote("");
            setKey(newKey());
          }
        });
      }}
    >
      <label>
        Amount received
        <input inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="250.00" required value={amount} />
      </label>
      <label>
        Check number (optional)
        <input maxLength={40} onChange={(event) => setCheckNumber(event.target.value)} value={checkNumber} />
      </label>
      <label>
        Received on
        <input onChange={(event) => setReceivedOn(event.target.value)} required type="date" value={receivedOn} />
      </label>
      <label>
        Note (optional)
        <input maxLength={500} onChange={(event) => setNote(event.target.value)} value={note} />
      </label>
      <span className="billing-inline-action">
        <button className="primary-button" disabled={busy || amount.trim() === ""} type="submit">{busy ? "Recording…" : "Record payment"}</button>
        {notice && <small role="status">{notice}</small>}
      </span>
      <small>Partial payments are fine. A payment cannot be edited; if one was entered by mistake, void it and enter the right one.</small>
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}

export function VoidPaymentButton({ eventId, paymentId }: { eventId: string; paymentId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const { busy, error, run } = useLedgerAction(eventId);
  if (!open) return <button className="secondary-button" onClick={() => setOpen(true)} type="button">Void</button>;
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run({ action: "void-payment", paymentId, reason, requestKey: key });
      }}
    >
      <label>
        Why void this payment
        <input maxLength={300} onChange={(event) => setReason(event.target.value)} required value={reason} />
      </label>
      <span className="billing-inline-action">
        <button className="secondary-button" disabled={busy || reason.trim() === ""} type="submit">{busy ? "Voiding…" : "Void payment"}</button>
        <button className="secondary-button" onClick={() => setOpen(false)} type="button">Cancel</button>
      </span>
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}

export function PaymentInstructionsForm({ eventId, value, defaultText }: { eventId: string; value: string | null; defaultText: string }) {
  const [text, setText] = useState(value ?? "");
  const { busy, error, notice, run } = useLedgerAction(eventId);
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run({ action: "set-payment-instructions", instructions: text.trim() === "" ? null : text }, () => "Saved.");
      }}
    >
      <label>
        Payment instruction printed on invoice PDFs
        <textarea maxLength={600} onChange={(event) => setText(event.target.value)} placeholder={defaultText} rows={2} value={text} />
      </label>
      <small>Leave it blank to print: “{defaultText}” A PDF that was already made keeps the text it had.</small>
      <span className="billing-inline-action">
        <button className="secondary-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save"}</button>
        {notice && <small role="status">{notice}</small>}
      </span>
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}

export type SendFormProps = {
  eventId: string;
  versionId: string;
  invoiceId: string;
  versionLabel: string;
  recipients: RecipientCandidate[];
  recipientsFingerprint: string;
  subject: string;
  body: string;
  isResend: boolean;
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  viewerName: string;
};

export function SendInvoiceForm(props: SendFormProps) {
  const router = useRouter();
  const [ticked, setTicked] = useState<string[]>(() => props.recipients.map((recipient) => recipient.key));
  const [subject, setSubject] = useState(props.subject);
  const [body, setBody] = useState(props.body);
  const [confirmed, setConfirmed] = useState(false);
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const confirmId = useId();
  const none = ticked.length === 0;
  async function send() {
    setBusy(true);
    setError("");
    try {
      const response = await post(`/api/events/${encodeURIComponent(props.eventId)}/invoices/send`, {
        versionId: props.versionId,
        recipients: ticked,
        recipientsFingerprint: props.recipientsFingerprint,
        subject,
        body,
        idempotencyKey: key,
        confirm: true,
      });
      setResult(response);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invoice could not be sent.");
    } finally {
      setBusy(false);
    }
  }
  if (result) {
    const outcome = (result.outcome ?? {}) as Record<string, number>;
    return (
      <div className="invoice-confirm" role="status">
        <p>
          <strong>{props.isResend ? "Resent" : "Sent"}.</strong> Invoice {String(result.number ?? props.versionLabel)} went to {String(result.recipientCount)} recipient{result.recipientCount === 1 ? "" : "s"}.
          {" "}
          {outcome.suppressed ? `${outcome.suppressed} recorded as suppressed (email is turned off for this event, nothing was emailed). ` : ""}
          {outcome.captured ? `${outcome.captured} captured locally (this event is in test mode, nothing was emailed). ` : ""}
          {outcome.queued ? `${outcome.queued} queued for delivery. ` : ""}
          {outcome.sent ? `${outcome.sent} sent. ` : ""}
          {outcome.failed ? `${outcome.failed} failed; see the history on the invoice. ` : ""}
        </p>
        <p><a href={`/finance/invoices/${props.invoiceId}?event=${encodeURIComponent(props.eventId)}&version=${props.versionId}`}>Back to the invoice</a></p>
      </div>
    );
  }
  return (
    <form
      className="billing-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <fieldset>
        <legend>Recipients</legend>
        {props.recipients.length === 0 && <p>There is nobody to send this invoice to. Add a billing contact under Billing responsibility.</p>}
        {props.recipients.map((recipient) => (
          <label key={recipient.key} style={{ display: "block" }}>
            <input
              checked={ticked.includes(recipient.key)}
              onChange={(event) => setTicked((current) => (event.target.checked ? [...current, recipient.key] : current.filter((entry) => entry !== recipient.key)))}
              type="checkbox"
            />{" "}
            <strong>{recipient.kind === "BILLING_CONTACT" ? "To" : "Copy"}:</strong> {recipient.name} &lt;{recipient.email}&gt;
            <small> · {recipient.detail}{recipient.unverified ? " · address not verified" : ""}</small>
            {recipient.priorProblem && <small role="status"> · <strong>{recipient.priorProblem}</strong></small>}
          </label>
        ))}
        <small>Untick anyone who should not get this one. At least one recipient is needed. Each person gets their own copy.</small>
      </fieldset>
      <label>
        Subject
        <input maxLength={200} onChange={(event) => setSubject(event.target.value)} required value={subject} />
      </label>
      <label>
        Message
        <textarea maxLength={5000} onChange={(event) => setBody(event.target.value)} required rows={10} value={body} />
      </label>
      <p><small>The invoice PDF for {props.versionLabel} is attached. It is the same file on every send; it is never regenerated.</small></p>
      <div className="invoice-confirm">
        <label htmlFor={confirmId}>
          <input checked={confirmed} id={confirmId} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
          <span>
            I, {props.viewerName}, am {props.isResend ? "resending" : "sending"} invoice {props.versionLabel} to the {ticked.length} recipient{ticked.length === 1 ? "" : "s"} ticked above.
          </span>
        </label>
      </div>
      <span className="billing-inline-action">
        <button className="primary-button" disabled={busy || none || !confirmed || subject.trim() === "" || body.trim() === ""} type="submit">
          {busy ? "Sending…" : props.isResend ? "Resend invoice" : "Send invoice"}
        </button>
      </span>
      {none && <small role="status">Tick at least one recipient to send.</small>}
      {error && <small className="form-error" role="alert">{error}</small>}
    </form>
  );
}

