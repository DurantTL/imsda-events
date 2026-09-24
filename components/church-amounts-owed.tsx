import Link from "next/link";
import { Building2, Download } from "lucide-react";
import {
  notBilledLabel,
  sortChurchAmountsOwed,
  summarizeChurchAmountsOwed,
  NO_CHURCH_ON_FILE,
  type ChurchAmountOwedRow,
} from "@/modules/club-registrations/church-owed";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * What each church owes for this event (#409): an estimate from the pricing
 * engine, billed to the church after the event and never paid online.
 * Read-only: no card payment and no attendee balance ever come from this
 * screen. Only submitted or confirmed clubs are billed; waitlisted and
 * cancelled clubs are listed separately at $0. Invoicing and recording the
 * church's payment are #165–#168, out of scope here.
 */
export function ChurchAmountsOwed({
  eventId,
  isDeferredOrganizationBilling,
  rows,
}: {
  eventId: string;
  isDeferredOrganizationBilling: boolean;
  rows: ChurchAmountOwedRow[];
}) {
  const summary = summarizeChurchAmountsOwed(rows);
  const sorted = sortChurchAmountsOwed(rows);
  const billed = sorted.filter((row) => row.isBilled);
  const notBilled = sorted.filter((row) => !row.isBilled);
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Financial operations</p>
          <h2>Owed by churches</h2>
          <p>
            Estimated amount each church owes for its clubs at this event — billed to the church after the event, not paid online.
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
          <strong>{summary.churchCount}</strong>
        </article>
        <article className="finance-stat">
          <span><Building2 aria-hidden="true" size={18} /></span>
          <small>Clubs billed</small>
          <strong>{summary.billedClubCount}</strong>
        </article>
        <article className="finance-stat warning">
          <span><Building2 aria-hidden="true" size={18} /></span>
          <small>Estimated amount owed</small>
          <strong>{money(summary.totalOwedCents)}</strong>
        </article>
      </section>
      {summary.churches.length > 0 && (
        <section className="panel finance-list" aria-label="Estimated amount owed by church">
          <div className="finance-row finance-head"><span>Church</span><span>Clubs billed</span><span /><span>Estimated amount owed</span></div>
          {summary.churches.map((church) => (
            <div className="finance-row" key={church.churchKey}>
              <span><strong>{church.churchName}</strong></span>
              <span>{church.clubCount} {church.clubCount === 1 ? "club" : "clubs"}</span>
              <span />
              <span>{money(church.amountOwedCents)}</span>
            </div>
          ))}
        </section>
      )}
      <section className="panel finance-list" aria-label="Clubs billed to their church">
        <div className="finance-row finance-head"><span>Club / church</span><span>Confirmation</span><span>Attendees</span><span>Estimated amount owed</span></div>
        {billed.map((row) => (
          <div className="finance-row" key={`${row.organizationId}-${row.confirmationCode}`}>
            <span><strong>{row.organizationName}</strong><small>{row.churchName ?? NO_CHURCH_ON_FILE} · {row.status.toLowerCase()}</small></span>
            <span>{row.confirmationCode}</span>
            <span>{row.attendeeCount} {row.attendeeCount === 1 ? "person" : "people"}</span>
            <span>{money(row.amountOwedCents)}</span>
          </div>
        ))}
        {billed.length === 0 && (
          <div className="empty-state">
            <Building2 aria-hidden="true" size={24} />
            <h3>No church-billed registrations</h3>
            <p>No club has a submitted registration for this event yet, or this event does not bill churches.</p>
          </div>
        )}
      </section>
      {notBilled.length > 0 && (
        <section className="panel finance-list" aria-label="Waitlisted and cancelled clubs">
          <div className="finance-row finance-head"><span>Waitlisted or cancelled club</span><span>Confirmation</span><span>Attendees</span><span>Owed</span></div>
          {notBilled.map((row) => (
            <div className="finance-row" key={`${row.organizationId}-${row.confirmationCode}`}>
              <span><strong>{row.organizationName}</strong><small>{row.churchName ?? NO_CHURCH_ON_FILE} · {notBilledLabel(row.status)}</small></span>
              <span>{row.confirmationCode}</span>
              <span>{row.attendeeCount} {row.attendeeCount === 1 ? "person" : "people"}</span>
              <span>{money(0)}</span>
            </div>
          ))}
        </section>
      )}
      <p className="field-help">
        <Link href={`/finance?event=${eventId}`}>Back to payments &amp; balances</Link>
      </p>
    </section>
  );
}
