import { SendInvoiceForm } from "@/components/invoice-ledger-controls";
import { invoiceMoney, invoiceWhen } from "@/components/invoices";
import { deliveryStatusLabel } from "@/modules/invoices/delivery-domain";
import type { SendPreview } from "@/modules/invoices/delivery-repository";

/**
 * Send (or resend) a finalized invoice (#168): the version, who it is for, the exact recipients with a tick box each,
 * the message, and the earlier sends. Nothing is sent by viewing this page. A version that a revision replaced shows
 * a notice and no form.
 */
export function InvoiceSendView({ preview, viewerName }: { preview: SendPreview; viewerName: string }) {
  const { version, snapshotContact, currentContact } = preview;
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Invoice</p>
          <h2>{preview.isResend ? "Resend" : "Send"} {version.number}</h2>
          <p>{version.organizationName} · {invoiceMoney(version.amountDueCents)} · finalized {invoiceWhen(version.finalizedAt)}</p>
        </div>
        <div className="page-intro-actions">
          <a className="secondary-button" href={`/finance/invoices/${preview.invoiceId}?event=${preview.eventId}&version=${version.id}`}>Back to the invoice</a>
        </div>
      </div>

      {preview.blockedReason && (
        <section className="panel billing-settings" role="status" aria-label="Cannot send">
          <p>
            <strong>{preview.blockedReason}</strong>
            {preview.newerVersion && <> <a href={`/finance/invoices/${preview.invoiceId}/send?event=${preview.eventId}&version=${preview.newerVersion.id}`}>Open {preview.newerVersion.number}</a>.</>}
          </p>
        </section>
      )}

      {preview.deliveryMode !== "EXTERNAL_EMAIL" && (
        <section className="panel billing-settings" role="status" aria-label="Delivery mode">
          <p>
            {preview.deliveryMode === "DISABLED"
              ? <><strong>Email is turned off for this event.</strong> Sending records the message as suppressed; nothing is emailed.</>
              : <><strong>This event captures email locally.</strong> Sending records the message but nothing leaves the system.</>}
            {" "}Change this in the event’s communication settings.
          </p>
        </section>
      )}

      {preview.contactChanged && (
        <section className="panel billing-settings" role="status" aria-label="Contact changed">
          <p>
            <strong>The billing contact changed since this invoice was finalized.</strong>{" "}
            The PDF still shows {snapshotContact?.name ?? "the contact it was finalized with"}, as finalized. This email goes to{" "}
            {currentContact ? `the current billing contact, ${currentContact.name}` : "nobody at the billing contact: the church has no active billing contact now, so only directors can be ticked"}.
          </p>
        </section>
      )}
      {!currentContact && !preview.contactChanged && (
        <section className="panel billing-settings" role="status" aria-label="No billing contact">
          <p><strong>This church has no active billing contact.</strong> Add one under Billing responsibility to include them.</p>
        </section>
      )}

      {preview.canSend && (
        <section className="panel billing-settings" aria-label="Send">
          <div className="section-heading"><h3>Message</h3></div>
          <p><small>From {preview.sender.name}{preview.sender.email ? ` <${preview.sender.email}>` : " (no sender address set)"}{preview.sender.replyTo ? ` · replies go to ${preview.sender.replyTo}` : ""}. Attachment: {preview.pdf.filename}.</small></p>
          <SendInvoiceForm
            body={preview.body}
            deliveryMode={preview.deliveryMode}
            eventId={preview.eventId}
            invoiceId={preview.invoiceId}
            isResend={preview.isResend}
            recipients={preview.recipients}
            recipientsFingerprint={preview.recipientsFingerprint}
            subject={preview.subject}
            versionId={version.id}
            versionLabel={version.number}
            viewerName={viewerName}
          />
        </section>
      )}

      <section className="panel finance-list" aria-label="Earlier sends">
        <div className="section-heading"><h3>Earlier sends</h3></div>
        {preview.history.length === 0 && <p style={{ padding: "0 17px" }}><small>This invoice has not been sent.</small></p>}
        {preview.history.map((entry) => (
          <div className="invoice-line" key={entry.id}>
            <span><strong>{entry.sequence === 1 ? "Sent" : "Resent"} {entry.versionNumber}</strong><small>{invoiceWhen(entry.sentAt)} by {entry.sentByName}</small></span>
            <span>{entry.recipients.map((recipient) => <small key={recipient.id}>{recipient.email}: {deliveryStatusLabel(recipient.status)}</small>)}</span>
            <span />
            <span />
          </div>
        ))}
      </section>
    </section>
  );
}
