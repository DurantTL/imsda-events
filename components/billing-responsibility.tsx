import { Building2, Download } from "lucide-react";
import {
  BillingActionButton,
  GroupingControl,
  LinkOrganizationForm,
  ResolveControls,
} from "@/components/billing-responsibility-controls";
import {
  READINESS_LABELS,
  isStaffDecision,
  lineLabel,
  partyKindLabel,
  sourceLabel,
  unresolvedReasonLabel,
  type BillingGroup,
} from "@/modules/billing-responsibility/domain";
import type { BillingResponsibilityView } from "@/modules/billing-responsibility/repository";
import { notBilledLabel } from "@/modules/club-registrations/church-owed";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function date(value: string) {
  return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Billing responsibility for a deferred-invoice event (#165, slice 1): who each registration is
 * billed to, whether that party's billing contact is ready, and a preview of how the invoices
 * would be grouped. Amounts are the #409 estimates; nothing here finalizes or sends an invoice.
 * Staff with MANAGE_FINANCE only (the page checks, and every action checks again).
 */
export function BillingResponsibility({
  eventId,
  isSystemAdministrator = false,
  locationId,
  view,
}: {
  eventId: string;
  /** Only a system administrator may change a billing contact; everyone else sees it read-only. */
  isSystemAdministrator?: boolean;
  locationId: string | null;
  view: BillingResponsibilityView;
}) {
  const { groups, summary, invoiceGrouping, lineHistory } = view;
  const unresolved = groups.find((group) => group.party.kind === "UNRESOLVED");
  const resolved = groups.filter((group) => group.party.kind !== "UNRESOLVED");
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Financial operations</p>
          <h2>Billing responsibility</h2>
          <p>
            Who is billed for each registration after the event, and whether we have a verified billing contact for them. Billing
            contacts are entered by office staff and kept for every event; they are never taken from a form answer, an email
            address, the club director, or the person who submitted the registration.
          </p>
        </div>
        <div className="page-intro-actions">
          <a className="secondary-button" href={`/api/events/${eventId}/exports/billing-responsibility${locationId ? `?location=${encodeURIComponent(locationId)}` : ""}`}>
            <Download aria-hidden="true" size={17} /> Export CSV
          </a>
          <a className="secondary-button" href={`/finance/church-owed?event=${eventId}`}>Owed by churches</a>
        </div>
      </div>
      {!view.isDeferred ? (
        <div className="panel empty-state">
          <Building2 aria-hidden="true" size={24} />
          <h3>This event is not billed to organizations</h3>
          <p>Billing responsibility applies to events where churches and groups are invoiced after the event.</p>
        </div>
      ) : (
        <>
          <p className="billing-estimate-note">Amounts are estimates based on registration. Invoices use the people checked in at the event.</p>
          <section className="finance-summary" aria-label="Billing responsibility summary">
            <article className="finance-stat"><span><Building2 aria-hidden="true" size={18} /></span><small>Invoice groups</small><strong>{summary.groupCount}</strong></article>
            <article className="finance-stat"><span><Building2 aria-hidden="true" size={18} /></span><small>Ready</small><strong>{summary.readyCount}</strong></article>
            <article className={`finance-stat${summary.needsContactCount > 0 ? " warning" : ""}`}><span><Building2 aria-hidden="true" size={18} /></span><small>Need a billing contact</small><strong>{summary.needsContactCount}</strong></article>
            <article className={`finance-stat${summary.unresolvedCount > 0 ? " warning" : ""}`}><span><Building2 aria-hidden="true" size={18} /></span><small>Unresolved registrations</small><strong>{summary.unresolvedCount}</strong></article>
          </section>
          <section className="panel billing-settings" aria-label="Grouping and resolution">
            <GroupingControl eventId={eventId} value={invoiceGrouping} />
            <p>
              {invoiceGrouping === "PER_CHURCH"
                ? "Several clubs of one church share that church's invoice, each club as its own line."
                : "Each club stands alone on its own invoice, still addressed to its church's billing contact."}
              {" "}This is a preview; no invoice is finalized here.
            </p>
            <ResolveControls eventId={eventId} />
            {view.unrecordedCount > 0 && <p><small>{view.unrecordedCount} registrations are shown as the system&apos;s proposal and are not recorded yet.</small></p>}
            {view.outdatedCount > 0 && <p><small>{view.outdatedCount} recorded {view.outdatedCount === 1 ? "registration is" : "registrations are"} out of date (a club&apos;s church changed). The current answer is shown; &ldquo;Record responsible parties&rdquo; updates {view.outdatedCount === 1 ? "it" : "them"}.</small></p>}
          </section>
          {unresolved && (
            <section className="panel finance-list billing-unresolved" aria-label="Unresolved registrations">
              <div className="section-heading"><h3>Unresolved ({unresolved.lines.length})</h3></div>
              <p>These registrations have no responsible organization. Nothing is guessed: link each one to a church, school, club or ministry.</p>
              {unresolved.lines.map((line) => (
                <div className="billing-line" key={line.registrationId}>
                  <span>
                    <strong>{lineLabel(line)}</strong>
                    <small>{line.confirmationCode} · {line.status.toLowerCase()} · {unresolvedReasonLabel(line.source)}{line.locationName ? ` · ${line.locationName}` : ""}</small>
                  </span>
                  <span>{line.isBilled ? money(line.owedCents) : notBilledLabel(line.status)}</span>
                  <span><LinkOrganizationForm eventId={eventId} hint={line.hint} needsReason={false} registrationId={line.registrationId} /></span>
                </div>
              ))}
            </section>
          )}
          {resolved.map((group) => (
            <GroupPanel eventId={eventId} group={group} isSystemAdministrator={isSystemAdministrator} key={group.key} lineHistory={lineHistory} />
          ))}
          {groups.length === 0 && (
            <div className="panel empty-state">
              <Building2 aria-hidden="true" size={24} />
              <h3>No registrations to bill yet</h3>
              <p>Submitted, confirmed, waitlisted and cancelled registrations appear here.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function GroupPanel({
  eventId,
  group,
  isSystemAdministrator,
  lineHistory,
}: {
  eventId: string;
  group: BillingGroup;
  isSystemAdministrator: boolean;
  lineHistory: BillingResponsibilityView["lineHistory"];
}) {
  const organizationId = group.party.kind === "ORGANIZATION" ? group.party.id : null;
  return (
    <section className="panel finance-list billing-group" aria-label={`Invoice group ${group.title}`}>
      <div className="section-heading">
        <div>
          <h3>{group.title}</h3>
          <small>{partyKindLabel(group.party)}{group.party.kind !== "UNRESOLVED" && group.party.name !== group.title ? ` · billed to ${group.party.name}` : ""}</small>
        </div>
        <span className={`count-badge billing-readiness billing-readiness-${group.readiness.toLowerCase()}`}>{READINESS_LABELS[group.readiness]}</span>
      </div>
      <div className="billing-contact">
        {group.party.kind === "PERSON" && <p>Group contact: <strong>{group.party.name}</strong>{group.party.email ? ` · ${group.party.email}` : " · no email on file"}</p>}
        {organizationId && (
          <>
            {group.contact ? (
              <p>
                <strong>{group.contact.name}</strong> ({group.contact.roleLabel}) · {group.contact.email}
                <br /><small>{group.contact.verifiedAt ? `Verified ${date(group.contact.verifiedAt)}` : "Not verified"} · since {date(group.contact.effectiveFrom)}</small>
              </p>
            ) : (
              <p>No billing contact on file.</p>
            )}
            {isSystemAdministrator && organizationId && (
              <a className="secondary-button" href={`/admin/organizations/${organizationId}/billing`}>Manage billing contact</a>
            )}
          </>
        )}
      </div>
      <div className="finance-row finance-head"><span>{group.lines.some((line) => line.clubId) ? "Club / registrant" : "Registrant"}</span><span>Confirmation</span><span>How decided</span><span>Estimated (registered)</span></div>
      {group.lines.map((line) => (
        <div className="finance-row" key={line.registrationId}>
          <span>
            <strong>{lineLabel(line)}</strong>
            <small>{line.status.toLowerCase()}{line.locationName ? ` · ${line.locationName}` : ""}{!line.recorded ? " · not recorded yet" : line.outdated ? " · recorded answer is out of date" : ""}</small>
            {line.reason && <small>Reason: {line.reason}</small>}
          </span>
          <span>{line.confirmationCode}</span>
          <span>
            {sourceLabel(line.source)}
            {line.party.kind !== "PERSON" && (
              <>
                {" "}
                <LinkOrganizationForm eventId={eventId} needsReason registrationId={line.registrationId} />
                {isStaffDecision(line.source) && (
                  <BillingActionButton body={{ action: "clear-override", registrationId: line.registrationId }} eventId={eventId} label="Use the system's answer" />
                )}
              </>
            )}
            {lineHistory[line.registrationId] && (
              <details>
                <summary>History</summary>
                <ul>
                  {lineHistory[line.registrationId]!.map((entry) => (
                    <li key={entry.id}>{date(entry.createdAt)} · {entry.changeType.replaceAll("_", " ").toLowerCase()}{entry.toOrganizationName ? ` to ${entry.toOrganizationName}` : ""}{entry.actorName ? ` by ${entry.actorName}` : ""}{entry.reason ? ` · ${entry.reason}` : ""}</li>
                  ))}
                </ul>
              </details>
            )}
          </span>
          <span>{line.isBilled ? money(line.owedCents) : notBilledLabel(line.status)}</span>
        </div>
      ))}
      <div className="finance-row">
        <span><strong>Group total (estimated, registered)</strong></span><span /><span>{group.billedCount} billed</span><span><strong>{money(group.owedCents)}</strong></span>
      </div>
    </section>
  );
}
