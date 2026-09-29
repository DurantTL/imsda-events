import Link from "next/link";
import { Building2, Download } from "lucide-react";
import {
  notBilledLabel,
  sortChurchAmountsOwed,
  summarizeChurchAmountsOwed,
  NO_CHURCH_ON_FILE,
  type ChurchAmountOwedRow,
} from "@/modules/club-registrations/church-owed";
import {
  summarizeSponsoredLines,
  type ChurchSponsoredPromoLine,
} from "@/modules/promo-codes/church-sponsored";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * What each church owes for this event (#409): an estimate from the pricing
 * engine, billed to the church after the event and never paid online.
 * Read-only: no card payment and no attendee balance ever come from this
 * screen. Only submitted or confirmed clubs are billed; waitlisted and
 * cancelled clubs are listed separately at $0. Church-sponsored promo code
 * lines (#545) are grouped under their church and show a confirmation code
 * and amount only, never an attendee name. Invoicing and recording the
 * church's payment are #165–#168, out of scope here.
 */
export function ChurchAmountsOwed({
  eventId,
  isDeferredOrganizationBilling,
  locationId = null,
  rows,
  sponsoredLines = [],
}: {
  eventId: string;
  isDeferredOrganizationBilling: boolean;
  /** The location filter (#413) the export follows; null exports every location. */
  locationId?: string | null;
  rows: ChurchAmountOwedRow[];
  sponsoredLines?: ChurchSponsoredPromoLine[];
}) {
  const summary = summarizeChurchAmountsOwed(rows);
  const sponsored = summarizeSponsoredLines(sponsoredLines);
  const churchesBilled = new Set([
    ...summary.churches.filter((church) => church.churchKey !== "none").map((church) => church.churchKey),
    ...sponsored.churches.map((church) => church.churchId),
  ]).size;
  const sorted = sortChurchAmountsOwed(rows);
  const billed = sorted.filter((row) => row.isBilled);
  const notBilled = sorted.filter((row) => !row.isBilled);
  // Registrations with no club (#606: Leadership Weekend, Outdoor School) are grouped by the church or organization the form names.
  const hasIndividuals = rows.some((row) => row.kind === "INDIVIDUAL");
  const unit = hasIndividuals ? "registration" : "club";
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Financial operations</p>
          <h2>Owed by churches</h2>
          <p>
            {hasIndividuals ? "Estimated amount each church or organization owes for its registrations at this event" : "Estimated amount each church owes for its clubs at this event"} — billed to the church after the event, not paid online.
            {!isDeferredOrganizationBilling && (sponsored.lineCount > 0
              ? " This event does not bill churches for club registrations; the amounts below are church-sponsored promo codes."
              : " This event does not bill churches, so no club registrations are billed here.")}
          </p>
        </div>
        <div className="page-intro-actions">
          <a className="secondary-button" href={`/api/events/${eventId}/exports/church-owed${locationId ? `?location=${encodeURIComponent(locationId)}` : ""}`}>
            <Download aria-hidden="true" size={17} /> Export CSV
          </a>
        </div>
      </div>
      <section className="finance-summary" aria-label="Church billing summary">
        <article className="finance-stat">
          <span><Building2 aria-hidden="true" size={18} /></span>
          <small>Churches billed</small>
          <strong>{churchesBilled}</strong>
        </article>
        <article className="finance-stat">
          <span><Building2 aria-hidden="true" size={18} /></span>
          <small>{hasIndividuals ? "Registrations billed" : "Clubs billed"}</small>
          <strong>{summary.billedClubCount}</strong>
        </article>
        {sponsored.lineCount > 0 && (
          <article className="finance-stat">
            <span><Building2 aria-hidden="true" size={18} /></span>
            <small>Sponsored promo codes</small>
            <strong>{sponsored.lineCount}</strong>
          </article>
        )}
        <article className="finance-stat warning">
          <span><Building2 aria-hidden="true" size={18} /></span>
          <small>Estimated amount owed</small>
          <strong>{money(summary.totalOwedCents + sponsored.totalCents)}</strong>
        </article>
      </section>
      {summary.churches.length > 0 && (
        <section className="panel finance-list" aria-label="Estimated amount owed by church">
          <div className="finance-row finance-head"><span>{hasIndividuals ? "Church or organization" : "Church"}</span><span>{hasIndividuals ? "Registrations billed" : "Clubs billed"}</span><span /><span>Estimated amount owed</span></div>
          {summary.churches.map((church) => (
            <div className="finance-row" key={church.churchKey}>
              <span><strong>{church.churchName}</strong></span>
              <span>{church.clubCount} {church.clubCount === 1 ? unit : `${unit}s`}</span>
              <span />
              <span>{money(church.amountOwedCents)}</span>
            </div>
          ))}
        </section>
      )}
      <section className="panel finance-list" aria-label={hasIndividuals ? "Registrations billed to their church or organization" : "Clubs billed to their church"}>
        <div className="finance-row finance-head"><span>{hasIndividuals ? "Registrant or club / church or organization" : "Club / church"}</span><span>Confirmation</span><span>Attendees</span><span>Estimated amount owed</span></div>
        {billed.map((row) => (
          <div className="finance-row" key={`${row.organizationId}-${row.confirmationCode}`}>
            <span><strong>{row.organizationName}</strong><small>{row.churchName ?? NO_CHURCH_ON_FILE} · {row.status.toLowerCase()}{row.locationName ? ` · ${row.locationName}` : ""}</small></span>
            <span>{row.confirmationCode}</span>
            <span>{row.attendeeCount} {row.attendeeCount === 1 ? "person" : "people"}</span>
            <span>{money(row.amountOwedCents)}</span>
          </div>
        ))}
        {billed.length === 0 && (
          <div className="empty-state">
            <Building2 aria-hidden="true" size={24} />
            <h3>{sponsored.lineCount > 0 ? "No church-billed club registrations" : "No church-billed registrations"}</h3>
            <p>{sponsored.lineCount > 0
              ? "No club is billed for this event. Church-sponsored promo codes are listed below."
              : "No club has a submitted registration for this event yet, or this event does not bill churches."}</p>
          </div>
        )}
      </section>
      {sponsored.churches.length > 0 && (
        <section className="panel finance-list" aria-label="Church-sponsored promo codes">
          <div className="finance-row finance-head"><span>Church-sponsored promo codes</span><span>Confirmation</span><span>Status</span><span>Discount owed</span></div>
          {sponsored.churches.map((church) => (
            <div key={church.churchId} className="finance-group">
              <div className="finance-row">
                <span><strong>{church.churchName}</strong><small>{church.lineCount} {church.lineCount === 1 ? "registration" : "registrations"} used a code this church sponsors</small></span>
                <span />
                <span />
                <span><strong>{money(church.amountCents)}</strong></span>
              </div>
              {church.lines.map((line) => (
                <div className="finance-row" key={line.lineId}>
                  <span><small>Promo code {line.promoCode}</small></span>
                  <span>{line.confirmationCode}</span>
                  <span>{line.status.toLowerCase()}</span>
                  <span>{money(line.amountCents)}</span>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
      {notBilled.length > 0 && (
        <section className="panel finance-list" aria-label={hasIndividuals ? "Waitlisted and cancelled registrations" : "Waitlisted and cancelled clubs"}>
          <div className="finance-row finance-head"><span>{hasIndividuals ? "Waitlisted or cancelled registration" : "Waitlisted or cancelled club"}</span><span>Confirmation</span><span>Attendees</span><span>Owed</span></div>
          {notBilled.map((row) => (
            <div className="finance-row" key={`${row.organizationId}-${row.confirmationCode}`}>
              <span><strong>{row.organizationName}</strong><small>{row.churchName ?? NO_CHURCH_ON_FILE} · {notBilledLabel(row.status)}{row.locationName ? ` · ${row.locationName}` : ""}</small></span>
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
