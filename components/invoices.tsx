import { FileText } from "lucide-react";
import { CreateDraftsControl, InvoiceCodeForm } from "@/components/invoice-controls";
import { blockerReasonLabel } from "@/modules/attendance-reconciliation/domain";
import { versionStatusLabel, type InvoiceVersionStatus } from "@/modules/invoices/domain";
import type { InvoiceListRow, InvoicesView } from "@/modules/invoices/repository";

export function invoiceMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function invoiceWhen(value: string) {
  return new Date(value).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

export function StatusBadge({ status }: { status: InvoiceVersionStatus }) {
  return <span className={`count-badge billing-readiness invoice-status-${status.toLowerCase()}`}>{versionStatusLabel(status)}</span>;
}

/** "SC27-0001-R1", or what the number will be built from while the invoice is still a draft. */
export function displayNumber(row: { number: string | null; baseNumber?: string | null; revision?: number }) {
  if (row.number) return row.number;
  if (row.baseNumber && row.revision) return `${row.baseNumber}-R${row.revision} (assigned when finalized)`;
  return "Number assigned when finalized";
}

/**
 * Finance, then Invoices, for a deferred-invoice event (#167): one invoice per invoice group, from the
 * approved attendance reconciliation. Staff with MANAGE_FINANCE see everything and create drafts;
 * finalizing is for people with the Finalize invoices permission. Nothing here sends an invoice (#168).
 */
export function Invoices({ eventId, view, canFinalize }: { eventId: string; view: InvoicesView; canFinalize: boolean }) {
  if (!view.isDeferred) {
    return (
      <section className="page-stack">
        <div className="page-intro"><div><p className="eyebrow">Financial operations</p><h2>Invoices</h2></div></div>
        <div className="panel empty-state">
          <FileText aria-hidden="true" size={24} />
          <h3>This event is not billed to organizations</h3>
          <p>Invoices apply to events where churches and groups are invoiced after the event.</p>
        </div>
      </section>
    );
  }
  const { approved, blockers, invoices, groupsWithoutInvoice } = view;
  const current = approved?.freshness === "CURRENT";
  const blocked = !approved || !current || blockers.length > 0;
  const reason = !approved
    ? "Approve an attendance reconciliation first."
    : !current
      ? "Attendance or billing facts changed since the reconciliation was approved. Prepare and approve it again."
      : "Finish billing responsibility first.";
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Financial operations</p>
          <h2>Invoices</h2>
          <p>
            One invoice per church or club, built from the approved attendance reconciliation. Review each draft, then a person with
            permission to finalize invoices approves it, which assigns its number. Nothing is sent from here, and the church and
            club director see nothing until staff send it.
          </p>
        </div>
        <div className="page-intro-actions">
          <a className="secondary-button" href={`/finance/attendance-reconciliation?event=${eventId}`}>Attendance reconciliation</a>
          <a className="secondary-button" href={`/finance/billing-responsibility?event=${eventId}`}>Billing responsibility</a>
        </div>
      </div>

      <section className="panel billing-settings" aria-label="Approved reconciliation">
        <div className="section-heading"><h3>Basis</h3></div>
        {approved ? (
          <p>
            <strong>Approved reconciliation: version {approved.versionNumber}</strong> · {invoiceMoney(approved.billableCents)} billable
            {approved.approvedAt ? ` · approved ${invoiceWhen(approved.approvedAt)}` : ""}
            {" "}
            {approved.freshness === "FACTS_CHANGED"
              ? <span className="count-badge billing-readiness billing-readiness-no_contact">Facts changed since approval</span>
              : approved.freshness === "CURRENT" ? <span className="count-badge billing-readiness billing-readiness-ready">Matches the facts now</span> : null}
          </p>
        ) : (
          <p>No attendance reconciliation has been approved yet, so no invoice can be drafted.</p>
        )}
        {blockers.length > 0 && (
          <>
            <p>Billing responsibility is not ready: <a href={`/finance/billing-responsibility?event=${eventId}`}>open Billing responsibility</a>.</p>
            <ul>{blockers.map((blocker) => <li key={blocker.registrationId}>{blocker.label} · {blocker.confirmationCode} · {blockerReasonLabel(blocker.reason)}</li>)}</ul>
          </>
        )}
        <span className="billing-inline-action">
          <CreateDraftsControl disabled={blocked} disabledReason={reason} eventId={eventId} />
        </span>
        <p><small>Creating drafts again refreshes drafts only. A finalized invoice is never changed; if it no longer matches, you will be offered a revision.</small></p>
        <p>
          <small>
            Who can finalize: system administrators{view.finalizers.length > 0 ? `, and ${view.finalizers.join(", ")}` : ""}. {canFinalize ? "You can finalize invoices." : "You can prepare drafts, but finalizing needs that permission, which a system administrator grants on the staff page."}
          </small>
        </p>
      </section>

      <section className="finance-summary" aria-label="Invoice summary">
        <article className="finance-stat"><small>Drafts</small><strong>{view.totals.draftCount}</strong></article>
        <article className="finance-stat"><small>Finalized</small><strong>{view.totals.finalizedCount}</strong></article>
        <article className="finance-stat"><small>Finalized total</small><strong>{invoiceMoney(view.totals.finalizedCents)}</strong></article>
      </section>

      <section className="panel finance-list" aria-label="Invoices">
        <div className="section-heading"><h3>Invoices ({invoices.length})</h3></div>
        {invoices.length === 0 && <p style={{ padding: "0 17px" }}>No invoices yet. Create drafts from the approved reconciliation.</p>}
        {invoices.map((row) => <InvoiceRow eventId={eventId} key={row.invoiceId} row={row} />)}
        {groupsWithoutInvoice.length > 0 && (
          <p style={{ padding: "0 17px" }}>
            <small>Not drafted yet: {groupsWithoutInvoice.map((group) => `${group.title} (${invoiceMoney(group.amountCents)})`).join(", ")}.</small>
          </p>
        )}
      </section>

      <section className="panel billing-settings" aria-label="Invoice number">
        <div className="section-heading"><h3>Invoice numbers</h3></div>
        <InvoiceCodeForm effective={view.code.effective} eventId={eventId} explicit={view.code.explicit} locked={view.code.locked} year={view.code.year} />
      </section>
    </section>
  );
}

function InvoiceRow({ eventId, row }: { eventId: string; row: InvoiceListRow }) {
  const shown = row.current;
  const contact = shown.contact;
  return (
    <div className="invoice-line">
      <span>
        <strong><a href={`/finance/invoices/${row.invoiceId}?event=${eventId}`}>{row.groupTitle}</a></strong>
        <small>{row.organizationName !== row.groupTitle ? `Billed to ${row.organizationName} · ` : ""}{shown.billableCount} billable of {shown.registeredCount} registered</small>
        {row.hasOpenRevision && <small>Revision {shown.revision} is a draft{row.finalized ? `; ${row.finalized.number} stays the live invoice until it is finalized` : ""}.</small>}
        {row.contactChanged && <small role="status"><strong>Contact changed since finalization.</strong> Open it to revise the contact.</small>}
        {row.amountsOutOfDate && <small role="status"><strong>No longer matches the approved reconciliation.</strong> Open it to revise the amounts.</small>}
      </span>
      <span>
        <StatusBadge status={shown.status} />
        <small>{displayNumber({ number: shown.number, baseNumber: row.baseNumber, revision: shown.revision })}</small>
      </span>
      <span><strong>{invoiceMoney(shown.amountDueCents)}</strong></span>
      <span>
        {contact ? <>{contact.name}<small>{contact.email}{contact.verified ? "" : " · not verified"}</small></> : <small>No billing contact</small>}
      </span>
    </div>
  );
}
