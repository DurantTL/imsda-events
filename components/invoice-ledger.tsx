import { PaymentInstructionsForm, PostToArForm, RecordPaymentForm, VoidPaymentButton } from "@/components/invoice-ledger-controls";
import { invoiceMoney, invoiceWhen } from "@/components/invoices";
import { DEFAULT_PAYMENT_INSTRUCTIONS, deliveryStatusLabel, settlementLabel } from "@/modules/invoices/delivery-domain";
import type { DeliveryHistoryEntry } from "@/modules/invoices/delivery-repository";
import type { FinanceReport, LedgerInvoice, LedgerPayment, PartyStatement, StatementParty, StatementTotals } from "@/modules/invoices/ledger-repository";

/**
 * Delivery, accounts receivable, payments, statements and the finance report for deferred-organization invoices
 * (#168). Staff with MANAGE_FINANCE on the event see these; nothing here is shown to a church or a club director,
 * and nothing is sent unless a staff member uses the Send button. The server checks the permission again on every
 * action.
 */

const dateOnly = (value: string) => value.slice(0, 10);

/** Send, download the PDF, and the history of sends (with bounce and suppression) for one invoice. */
export function InvoiceDeliveryPanel({
  eventId,
  invoiceId,
  shown,
  liveVersion,
  history,
}: {
  eventId: string;
  invoiceId: string;
  shown: { id: string; number: string; status: "FINALIZED" | "SUPERSEDED" };
  liveVersion: { id: string; number: string } | null;
  history: DeliveryHistoryEntry[];
}) {
  const superseded = shown.status === "SUPERSEDED";
  const sentOfThisVersion = history.filter((entry) => entry.versionNumber === shown.number);
  return (
    <section className="panel billing-settings" aria-label="Delivery">
      <div className="section-heading"><h3>Delivery</h3></div>
      <p>
        <small>
          An invoice is never sent automatically. Finalizing it did not send it, and the church and club director see nothing until a staff member
          sends it here. There are no reminders or scheduled emails.
        </small>
      </p>
      {superseded ? (
        <p role="status">
          <strong>This version was replaced{liveVersion ? ` by ${liveVersion.number}` : ""}, so it cannot be sent.</strong>
          {liveVersion && <> <a href={`/finance/invoices/${invoiceId}?event=${eventId}&version=${liveVersion.id}`}>Open the newer version</a> to send it.</>}
        </p>
      ) : (
        <span className="billing-inline-action">
          <a className="primary-button" href={`/finance/invoices/${invoiceId}/send?event=${eventId}&version=${shown.id}`}>
            {sentOfThisVersion.length > 0 ? "Resend invoice…" : "Send invoice…"}
          </a>
          <small>You will see the exact recipients and the message before anything is sent.</small>
        </span>
      )}
      <p>
        <a className="secondary-button" href={`/api/events/${encodeURIComponent(eventId)}/invoices/versions/${shown.id}/pdf`}>Download PDF of {shown.number}</a>
      </p>
      {history.length === 0 ? (
        <p><small>This invoice has not been sent.</small></p>
      ) : (
        <div className="finance-list">
          {history.map((entry) => (
            <div className="invoice-line" key={entry.id}>
              <span>
                <strong>{entry.sequence === 1 ? "Sent" : "Resent"} {entry.versionNumber}</strong>
                <small>{invoiceWhen(entry.sentAt)} by {entry.sentByName} · “{entry.subject}”</small>
                {entry.contactChangedSinceFinalization && <small>The billing contact had changed since finalization when this was sent.</small>}
                <small>PDF fingerprint {entry.documentSha256.slice(0, 12)}…</small>
              </span>
              <span>
                {entry.recipients.map((recipient) => (
                  <small key={recipient.id}>
                    {recipient.kind === "BILLING_CONTACT" ? "To" : "Copy"} {recipient.email}: <strong>{deliveryStatusLabel(recipient.status)}</strong>
                    {recipient.problem && recipient.detail ? ` (${recipient.detail})` : ""}
                  </small>
                ))}
              </span>
              <span />
              <span />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PaymentRow({ eventId, payment, canVoid }: { eventId: string; payment: LedgerPayment; canVoid: boolean }) {
  const isReversal = payment.kind === "REVERSAL";
  return (
    <div className="invoice-line">
      <span style={payment.voided ? { textDecoration: "line-through" } : undefined}>
        <strong>{isReversal ? "Voided payment" : "Payment"}: {invoiceMoney(isReversal ? -payment.amountCents : payment.amountCents)}</strong>
        <small>
          {isReversal ? `entered ${dateOnly(payment.receivedOn)}` : `received ${dateOnly(payment.receivedOn)}`}
          {payment.checkNumber ? ` · check ${payment.checkNumber}` : ""} · recorded against {payment.versionNumber} by {payment.recordedByName}
        </small>
        {payment.note && <small>{payment.note}</small>}
        {payment.reason && <small>Reason: {payment.reason}</small>}
      </span>
      <span>{payment.voided ? <small>Voided</small> : null}</span>
      <span />
      <span>{canVoid && !isReversal && !payment.voided ? <VoidPaymentButton eventId={eventId} paymentId={payment.id} /> : null}</span>
    </div>
  );
}

/** AR status, payments and what is outstanding for one invoice. The forms are shown on the live finalized version. */
export function InvoiceLedgerPanel({ eventId, ledger, shownVersionId }: { eventId: string; ledger: LedgerInvoice; shownVersionId: string }) {
  const shown = ledger.versions.find((version) => version.id === shownVersionId) ?? ledger.live;
  const isLive = shown.id === ledger.live.id;
  const { figures } = ledger;
  return (
    <>
      <section className="panel billing-settings" aria-label="Accounts receivable">
        <div className="section-heading"><h3>Accounts receivable</h3></div>
        {shown.posting ? (
          <p>
            <strong>Posted to AR on {shown.posting.postedOn}</strong>
            {shown.posting.reference ? ` · reference ${shown.posting.reference}` : ""}
            <br />
            <small>Recorded by {shown.posting.recordedByName} {invoiceWhen(shown.posting.createdAt)}{shown.postingCount > 1 ? ` · corrected ${shown.postingCount - 1} ${shown.postingCount === 2 ? "time" : "times"}` : ""}{shown.posting.reason ? ` · reason: ${shown.posting.reason}` : ""}.</small>
          </p>
        ) : (
          <p>{shown.status === "SUPERSEDED" ? "This replaced version was never posted to AR." : "Not posted to AR yet."}</p>
        )}
        {isLive && <PostToArForm eventId={eventId} posted={shown.posting ? { postedOn: shown.posting.postedOn, reference: shown.posting.reference } : null} versionId={shown.id} />}
        {!isLive && <p><small>The posting that counts is on the live version {ledger.live.number}. A revision is posted again, since the amount changed.</small></p>}
      </section>

      <section className="panel billing-settings" aria-label="Payments">
        <div className="section-heading"><h3>Payments</h3></div>
        <p>
          <strong>Outstanding {invoiceMoney(figures.outstandingCents)}</strong> · invoiced {invoiceMoney(figures.amountDueCents)} ({ledger.live.number}) · paid {invoiceMoney(figures.paidCents)} · <span>{settlementLabel(ledger.settlement)}</span>
        </p>
        {figures.overpaidCents > 0 && <p role="status"><strong>Overpaid by {invoiceMoney(figures.overpaidCents)}.</strong> More has been recorded than this invoice totals. Refunds are not handled here; check the entries below.</p>}
        <p>
          <small>
            Outstanding is the live version’s total less every payment on this invoice, whichever version it was recorded against, so a revision keeps what was already paid.
          </small>
        </p>
        <div className="finance-list">
          {ledger.payments.length === 0 && <p style={{ padding: "0 17px" }}><small>No payments recorded.</small></p>}
          {ledger.payments.map((payment) => <PaymentRow canVoid eventId={eventId} key={payment.id} payment={payment} />)}
        </div>
        <RecordPaymentForm eventId={eventId} invoiceId={ledger.invoiceId} />
      </section>
    </>
  );
}

function TotalsRow({ totals }: { totals: StatementTotals }) {
  return (
    <section className="finance-summary" aria-label="Totals">
      <article className="finance-stat"><small>Invoices</small><strong>{totals.invoiceCount}</strong></article>
      <article className="finance-stat"><small>Invoiced</small><strong>{invoiceMoney(totals.invoicedCents)}</strong></article>
      <article className="finance-stat"><small>Paid</small><strong>{invoiceMoney(totals.paidCents)}</strong></article>
      <article className="finance-stat"><small>Outstanding</small><strong>{invoiceMoney(totals.outstandingCents)}</strong></article>
      {totals.overpaidCents > 0 && <article className="finance-stat"><small>Overpaid</small><strong>{invoiceMoney(totals.overpaidCents)}</strong></article>}
    </section>
  );
}

/** Every church (or billing person) with a finalized invoice on this event. */
export function StatementsList({ eventId, eventName, parties, totals }: { eventId: string; eventName: string; parties: StatementParty[]; totals: StatementTotals }) {
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Financial operations</p>
          <h2>Statements</h2>
          <p>One statement per church for {eventName}: finalized invoices, revisions, payments and what is still outstanding. Only this event’s invoices are shown.</p>
        </div>
        <div className="page-intro-actions">
          <a className="secondary-button" href={`/finance/invoices?event=${eventId}`}>All invoices</a>
          <a className="secondary-button" href={`/api/events/${encodeURIComponent(eventId)}/exports/invoices`}>Download CSV for the treasurer</a>
        </div>
      </div>
      <TotalsRow totals={totals} />
      <section className="panel finance-list" aria-label="Statements">
        <div className="section-heading"><h3>Churches ({parties.length})</h3></div>
        {parties.length === 0 && <p style={{ padding: "0 17px" }}>No invoice has been finalized for this event yet.</p>}
        {parties.map((party) => (
          <div className="invoice-line" key={party.partyId}>
            <span>
              <strong><a href={`/finance/invoices/statements/${encodeURIComponent(party.partyId)}?event=${eventId}`}>{party.name}</a></strong>
              <small>{party.totals.invoiceCount} invoice{party.totals.invoiceCount === 1 ? "" : "s"}{party.lastSentAt ? ` · last sent ${invoiceWhen(party.lastSentAt)}` : " · not sent yet"}</small>
            </span>
            <span><small>Invoiced</small><strong>{invoiceMoney(party.totals.invoicedCents)}</strong></span>
            <span><small>Paid</small>{invoiceMoney(party.totals.paidCents)}</span>
            <span><small>Outstanding</small><strong>{invoiceMoney(party.totals.outstandingCents)}</strong>{party.totals.overpaidCents > 0 && <small>overpaid {invoiceMoney(party.totals.overpaidCents)}</small>}</span>
          </div>
        ))}
      </section>
    </section>
  );
}

/** One church's statement for one event. Superseded versions are history, and voided payments are struck through. */
export function PartyStatementView({ statement }: { statement: PartyStatement }) {
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Statement</p>
          <h2>{statement.name}</h2>
          <p>{statement.eventName}. Finalized invoices, payments and what is outstanding. Attendee payments are not mixed in.</p>
        </div>
        <div className="page-intro-actions">
          <a className="secondary-button" href={`/finance/invoices/statements?event=${statement.eventId}`}>All statements</a>
        </div>
      </div>
      <TotalsRow totals={statement.totals} />
      {statement.invoices.map((invoice) => (
        <section className="panel finance-list" aria-label={`Invoice ${invoice.live.number}`} key={invoice.invoiceId}>
          <div className="section-heading"><h3><a href={`/finance/invoices/${invoice.invoiceId}?event=${statement.eventId}`}>{invoice.live.number}</a> · {invoice.groupTitle}</h3></div>
          <div className="invoice-line">
            <span>
              <strong>Total {invoiceMoney(invoice.figures.amountDueCents)}</strong>
              <small>{invoice.live.posting ? `Posted to AR ${invoice.live.posting.postedOn}${invoice.live.posting.reference ? ` (${invoice.live.posting.reference})` : ""}` : "Not posted to AR"} · {invoice.live.lastSentAt ? `last sent ${invoiceWhen(invoice.live.lastSentAt)}` : "not sent"}</small>
            </span>
            <span><small>Paid</small>{invoiceMoney(invoice.figures.paidCents)}</span>
            <span><small>Outstanding</small><strong>{invoiceMoney(invoice.figures.outstandingCents)}</strong></span>
            <span><small>{settlementLabel(invoice.settlement)}</small>{invoice.figures.overpaidCents > 0 && <small>overpaid {invoiceMoney(invoice.figures.overpaidCents)}</small>}</span>
          </div>
          {invoice.versions.filter((version) => version.id !== invoice.live.id).map((version) => (
            <div className="invoice-line" key={version.id}>
              <span><strong>{version.number}</strong><small>replaced{version.supersededAt ? ` ${invoiceWhen(version.supersededAt)}` : ""} · history</small></span>
              <span><small>was</small>{invoiceMoney(version.amountDueCents)}</span>
              <span><small>{version.posting ? `posted to AR ${version.posting.postedOn}` : "never posted to AR"}</small></span>
              <span />
            </div>
          ))}
          {invoice.payments.map((payment) => <PaymentRow canVoid={false} eventId={statement.eventId} key={payment.id} payment={payment} />)}
          {invoice.payments.length === 0 && <p style={{ padding: "0 17px" }}><small>No payments recorded.</small></p>}
        </section>
      ))}
    </section>
  );
}

/** The event's finance report section: deferred receivables apart from attendee payments. */
export function FinanceReportPanel({ eventId, report, paymentInstructions }: { eventId: string; report: FinanceReport; paymentInstructions: string | null }) {
  return (
    <>
      <section className="panel billing-settings" aria-label="Deferred receivables report">
        <div className="section-heading"><h3>Finance report: deferred receivables</h3></div>
        <p><small>Church and club invoices for {report.eventName}, kept apart from what attendees paid themselves.</small></p>
        <section className="finance-summary" aria-label="Receivables">
          <article className="finance-stat"><small>Submitted headcount</small><strong>{report.headcount.submitted}</strong></article>
          <article className="finance-stat"><small>Billable units</small><strong>{report.headcount.billable}</strong></article>
          <article className="finance-stat"><small>Invoiced</small><strong>{invoiceMoney(report.invoiced.amountCents)}</strong></article>
          <article className="finance-stat"><small>Paid</small><strong>{invoiceMoney(report.paidCents)}</strong></article>
          <article className="finance-stat"><small>Outstanding</small><strong>{invoiceMoney(report.outstandingCents)}</strong></article>
        </section>
        <p>
          <small>
            {report.invoiced.invoiceCount} finalized invoice{report.invoiced.invoiceCount === 1 ? "" : "s"} · {report.invoiced.postedToArCount} posted to AR ({invoiceMoney(report.invoiced.postedToArCents)}) · {report.invoiced.sentCount} sent, {report.invoiced.notSentCount} not sent · {report.invoicesWithOutstanding} with a balance
            {report.overpaidCents > 0 ? ` · ${invoiceMoney(report.overpaidCents)} overpaid` : ""}{report.draftCount > 0 ? ` · ${report.draftCount} draft${report.draftCount === 1 ? "" : "s"} not finalized` : ""}.
          </small>
        </p>
        <p><small>Attendee payments for this event, net of refunds, are separate: {invoiceMoney(report.attendeePayments.netCents)}.</small></p>
        <p className="billing-inline-action">
          <a className="secondary-button" href={`/finance/invoices/statements?event=${eventId}`}>Statements by church</a>
          <a className="secondary-button" href={`/api/events/${encodeURIComponent(eventId)}/exports/invoices`}>Download CSV for the treasurer</a>
        </p>
      </section>
      <section className="panel billing-settings" aria-label="Payment instruction">
        <div className="section-heading"><h3>Payment instruction</h3></div>
        <PaymentInstructionsForm defaultText={DEFAULT_PAYMENT_INSTRUCTIONS} eventId={eventId} value={paymentInstructions} />
      </section>
    </>
  );
}
