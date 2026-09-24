import Link from "next/link";
import { Building2, Download } from "lucide-react";
import type { ChurchAmountOwed } from "@/modules/club-registrations/repository";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * What each club owes for this event, billed to the church (#409). Read-only:
 * no card payment and no attendee balance ever come from this screen. Invoice
 * and payment recording against the invoice are #165–#168, out of scope here.
 */
export function ChurchAmountsOwed({
  eventId,
  isDeferredOrganizationBilling,
  rows,
}: {
  eventId: string;
  isDeferredOrganizationBilling: boolean;
  rows: ChurchAmountOwed[];
}) {
  const total = rows.reduce((sum, row) => sum + row.amountOwedCents, 0);
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Financial operations</p>
          <h2>Owed by churches</h2>
          <p>
            What each club&apos;s church owes for this event — billed to the church directly, not paid online.
            {!isDeferredOrganizationBilling && " This event does not bill churches, so no club registrations are billed here."}
          </p>
        </div>
        <div className="page-intro-actions">
          <a className="secondary-button" href={`/api/events/${eventId}/exports/church-owed`}>
            <Download aria-hidden="true" size={17} /> Export CSV
          </a>
        </div>
      </div>
      <section className="finance-summary" aria-label="Church billing summary">
        <article className="finance-stat">
          <span><Building2 aria-hidden="true" size={18} /></span>
          <small>Churches billed</small>
          <strong>{rows.length}</strong>
        </article>
        <article className="finance-stat warning">
          <span><Building2 aria-hidden="true" size={18} /></span>
          <small>Total owed</small>
          <strong>{money(total)}</strong>
        </article>
      </section>
      <section className="panel finance-list">
        <div className="finance-row finance-head"><span>Church / club</span><span>Confirmation</span><span>Attendees</span><span>Owed</span></div>
        {rows.map((row) => (
          <div className="finance-row" key={`${row.organizationId}-${row.confirmationCode}`}>
            <span><strong>{row.organizationName}</strong><small>{row.status.toLowerCase()}</small></span>
            <span>{row.confirmationCode}</span>
            <span>{row.attendeeCount} {row.attendeeCount === 1 ? "person" : "people"}</span>
            <span>{money(row.amountOwedCents)}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="empty-state">
            <Building2 aria-hidden="true" size={24} />
            <h3>No church-billed registrations</h3>
            <p>No club has registered for this event yet, or this event does not bill churches.</p>
          </div>
        )}
      </section>
      <p className="field-help">
        <Link href={`/finance?event=${eventId}`}>Back to payments &amp; balances</Link>
      </p>
    </section>
  );
}
