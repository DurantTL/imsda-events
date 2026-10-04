import { ClipboardCheck, Download } from "lucide-react";
import { AcknowledgeForm, ApproveControl, CorrectionForm, PrepareControl } from "@/components/attendance-reconciliation-controls";
import {
  basisLabel,
  blockerReasonLabel,
  correctionLabel,
  personStateLabel,
  rosterReviewReasonLabel,
  type Counts,
  type GroupResult,
  type RegistrationResult,
} from "@/modules/attendance-reconciliation/domain";
import type { AttendanceReconciliationView, VersionSummary } from "@/modules/attendance-reconciliation/repository";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function when(value: string) {
  return new Date(value).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

function CountCells({ counts }: { counts: Counts }) {
  return (
    <>
      <span>{counts.registered}</span>
      <span>{counts.checkedIn}</span>
      <span>{counts.noShow}</span>
      <span>{counts.addedByStaff > 0 || counts.removedByStaff > 0 ? `+${counts.addedByStaff} / −${counts.removedByStaff}` : "0"}</span>
      <span><strong>{counts.billable}</strong></span>
    </>
  );
}

const HEAD = (
  <div className="finance-row finance-head attendance-row">
    <span>Group or registration</span><span>Registered</span><span>Checked in</span><span>No-show</span><span>Adjusted by staff</span><span>Billable</span><span>Estimated (registered)</span><span>Billable amount</span>
  </div>
);

/**
 * Attendance reconciliation for a deferred-invoice event (#166): per invoice group and per
 * registration, registered, checked in, no-show, staff-adjusted and billable counts side by side,
 * with the estimated and billable amounts, and a drilldown to the people. Billable means
 * attended: checked in, adjusted by staff corrections. Staff with MANAGE_FINANCE only (the page
 * checks, and every action checks again). Nothing here finalizes or sends an invoice.
 */
export function AttendanceReconciliation({
  eventId,
  locationId,
  view,
}: {
  eventId: string;
  locationId: string | null;
  view: AttendanceReconciliationView;
}) {
  if (!view.isDeferred) {
    return (
      <section className="page-stack">
        <div className="page-intro"><div><p className="eyebrow">Financial operations</p><h2>Attendance reconciliation</h2></div></div>
        <div className="panel empty-state">
          <ClipboardCheck aria-hidden="true" size={24} />
          <h3>This event is not billed to organizations</h3>
          <p>Attendance reconciliation applies to events where churches and groups are invoiced after the event.</p>
        </div>
      </section>
    );
  }
  const { result, blockers, approved, draft, versions, shown, correctionDetails, acknowledgementDetails, reviewPending } = view;
  const isLive = shown.kind === "LIVE";
  const locationQuery = locationId ? `location=${encodeURIComponent(locationId)}` : "";
  const exportQuery = [shown.kind === "VERSION" ? `version=${encodeURIComponent(shown.version.id)}` : "", locationQuery].filter(Boolean).join("&");
  const blocked = blockers.length > 0;
  const draftIsCurrent = draft && view.draftFreshness === "CURRENT";
  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Financial operations</p>
          <h2>Attendance reconciliation</h2>
          <p>
            Churches are billed for the people who were checked in, not everyone registered. Review who came, correct the check-in
            record where it is wrong (every correction needs a reason), then prepare and approve a reconciliation. Nothing is
            invoiced or sent from here.
          </p>
        </div>
        <div className="page-intro-actions">
          <a className="secondary-button" href={`/api/events/${eventId}/exports/attendance-reconciliation${exportQuery ? `?${exportQuery}` : ""}`}>
            <Download aria-hidden="true" size={17} /> Export CSV
          </a>
          <a className="secondary-button" href={`/finance/billing-responsibility?event=${eventId}`}>Billing responsibility</a>
          <a className="secondary-button" href={`/finance/church-owed?event=${eventId}`}>Owed by churches</a>
        </div>
      </div>
      <p className="billing-estimate-note">
        Amounts before the event are estimates based on registration. The billable amount applies the same rates, late price and
        meal-sponsorship credit to the people who attended.
      </p>

      {blocked && (
        <section className="panel billing-unresolved" aria-label="Billing responsibility is not ready">
          <div className="section-heading"><h3>Billing responsibility is not ready ({blockers.length})</h3></div>
          <p>
            Invoices go to the recorded responsible party, so a reconciliation can be prepared or approved only when every billed
            registration has one. <a href={`/finance/billing-responsibility?event=${eventId}`}>Open Billing responsibility</a> to record, link or fix these:
          </p>
          <ul>
            {blockers.map((blocker) => (
              <li key={blocker.registrationId}>{blocker.label} · {blocker.confirmationCode} · {blockerReasonLabel(blocker.reason)}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel billing-settings" aria-label="Reconciliation versions">
        <div className="section-heading"><h3>Reconciliation</h3></div>
        {approved ? (
          <p>
            <strong>Approved: version {approved.versionNumber}</strong> · {approved.counts.billable} billable people · {money(approved.billableCents)}
            {" "}· approved {approved.approvedAt ? when(approved.approvedAt) : ""}{approved.approvedByName ? ` by ${approved.approvedByName}` : ""}
            {view.approvedFreshness === "FACTS_CHANGED" && (
              <>
                {" "}<span className="count-badge billing-readiness billing-readiness-no_contact">Facts changed since approval</span>
                <br /><small>This approved version is unchanged. Attendance or billing facts have moved since; prepare a new draft to review the difference.</small>
              </>
            )}
            {view.approvedFreshness === "CURRENT" && <> <span className="count-badge billing-readiness billing-readiness-ready">Matches the facts now</span></>}
          </p>
        ) : (
          <p>No reconciliation has been approved yet.</p>
        )}
        {draft && (
          <p>
            <strong>Draft: version {draft.versionNumber}</strong> · {draft.counts.billable} billable people · {money(draft.billableCents)} · prepared {when(draft.preparedAt)}{draft.preparedByName ? ` by ${draft.preparedByName}` : ""}
            {" "}· <a href={`/finance/attendance-reconciliation?event=${eventId}&version=${draft.id}`}>Review this draft</a>
            {!draftIsCurrent && <><br /><small>Facts have changed since this draft was prepared. Prepare again to review the new numbers; this draft can no longer be approved.</small></>}
          </p>
        )}
        <span className="billing-inline-action">
          <PrepareControl disabled={blocked} disabledReason="Finish billing responsibility first." eventId={eventId} />
          {draft && draftIsCurrent && <ApproveControl disabled={blocked || reviewPending.length > 0} eventId={eventId} versionId={draft.id} versionNumber={draft.versionNumber} />}
        </span>
        {reviewPending.length > 0 && (
          <p><small>Approval waits for {reviewPending.length} roster {reviewPending.length === 1 ? "review" : "reviews"} below (&ldquo;Needs review&rdquo;). Acknowledge {reviewPending.length === 1 ? "it" : "each"} with a reason, then prepare again.</small></p>
        )}
        <p><small>Preparing is for the whole event, whatever location is selected below. Preparing again with nothing changed makes no new version.</small></p>
      </section>

      {!isLive && shown.kind === "VERSION" && (
        <p className="billing-estimate-note">
          Showing the saved snapshot of version {shown.version.versionNumber} ({shown.version.status.toLowerCase()}), prepared {when(shown.version.preparedAt)}.
          {" "}<a href={`/finance/attendance-reconciliation?event=${eventId}${locationQuery ? `&${locationQuery}` : ""}`}>Show the facts now</a>
        </p>
      )}

      <section className="finance-summary" aria-label="Reconciliation summary">
        <article className="finance-stat"><small>Registered</small><strong>{result.totals.registered}</strong></article>
        <article className="finance-stat"><small>Checked in</small><strong>{result.totals.checkedIn}</strong></article>
        <article className="finance-stat"><small>No-show</small><strong>{result.totals.noShow}</strong></article>
        <article className="finance-stat"><small>Adjusted by staff</small><strong>+{result.totals.addedByStaff} / −{result.totals.removedByStaff}</strong></article>
        <article className="finance-stat"><small>Billable</small><strong>{result.totals.billable}</strong></article>
        <article className="finance-stat"><small>Estimated → billable</small><strong>{money(result.totals.estimatedCents)} → {money(result.totals.billableCents)}</strong></article>
      </section>

      {result.groups.length === 0 && (
        <div className="panel empty-state">
          <ClipboardCheck aria-hidden="true" size={24} />
          <h3>No registrations to reconcile yet</h3>
          <p>Submitted and confirmed registrations appear here.</p>
        </div>
      )}
      {result.groups.map((group) => <GroupPanel acknowledgementDetails={acknowledgementDetails} correctionDetails={correctionDetails} eventId={eventId} group={group} isLive={isLive} key={group.key} />)}

      <section className="panel finance-list" aria-label="Version history">
        <div className="section-heading"><h3>Version history</h3></div>
        {versions.length === 0 && <p>No versions yet.</p>}
        {versions.map((version) => <VersionRow eventId={eventId} key={version.id} shownId={shown.kind === "VERSION" ? shown.version.id : null} version={version} />)}
      </section>
    </section>
  );
}

function VersionRow({ eventId, version, shownId }: { eventId: string; version: VersionSummary; shownId: string | null }) {
  return (
    <div className="billing-line">
      <span>
        <strong>Version {version.versionNumber}</strong> · {version.status.toLowerCase()}
        <small>
          prepared {when(version.preparedAt)}{version.preparedByName ? ` by ${version.preparedByName}` : ""}
          {version.approvedAt ? ` · approved ${when(version.approvedAt)}${version.approvedByName ? ` by ${version.approvedByName}` : ""}` : ""}
          {version.supersededAt ? ` · replaced ${when(version.supersededAt)}` : ""}
        </small>
      </span>
      <span>{version.counts.registered} registered · {version.counts.checkedIn} checked in · {version.counts.noShow} no-show · {version.counts.billable} billable</span>
      <span>{money(version.estimatedCents)} → {money(version.billableCents)}</span>
      <span>{shownId === version.id ? "Shown" : <a href={`/finance/attendance-reconciliation?event=${eventId}&version=${version.id}`}>View</a>}</span>
    </div>
  );
}

type Details = Record<string, { reason: string; actorName: string | null; createdAt: string }>;

function GroupPanel({ eventId, group, isLive, correctionDetails, acknowledgementDetails }: { eventId: string; group: GroupResult; isLive: boolean; correctionDetails: Details; acknowledgementDetails: Details }) {
  return (
    <section className="panel finance-list billing-group" aria-label={`Invoice group ${group.title}`}>
      <div className="section-heading">
        <div>
          <h3>{group.title}</h3>
          <small>{group.partyKind === "UNRESOLVED" ? "No responsible party yet" : group.partyName !== group.title ? `Billed to ${group.partyName}` : group.partyKind === "PERSON" ? "Billed to a person" : "Billed to an organization"}</small>
        </div>
      </div>
      {HEAD}
      {group.registrations.map((registration) => <RegistrationRow acknowledgementDetails={acknowledgementDetails} correctionDetails={correctionDetails} eventId={eventId} isLive={isLive} key={registration.registrationId} registration={registration} />)}
      <div className="finance-row attendance-row">
        <span><strong>Group total</strong></span><CountCells counts={group.counts} /><span>{money(group.estimatedCents)}</span><span><strong>{money(group.billableCents)}</strong></span>
      </div>
    </section>
  );
}

function RegistrationRow({ eventId, registration, isLive, correctionDetails, acknowledgementDetails }: { eventId: string; registration: RegistrationResult; isLive: boolean; correctionDetails: Details; acknowledgementDetails: Details }) {
  const review = registration.review && registration.review.reasons.length > 0 ? registration.review : null;
  const acknowledgement = review?.acknowledgementId ? acknowledgementDetails[review.acknowledgementId] : undefined;
  return (
    <div className="finance-row attendance-row">
      <span>
        <strong>{registration.label}</strong>
        <small>{registration.confirmationCode}{registration.locationName ? ` · ${registration.locationName}` : ""} · {basisLabel(registration.basis)}</small>
        {review && (
          <small role="status">
            <strong>{review.acknowledged ? "Roster review acknowledged" : "Needs review: roster changed after pricing"}</strong>
            {" "}({review.reasons.map(rosterReviewReasonLabel).join("; ")}). Until staff choose a figure the prorated amount is used, and approval waits.
            {acknowledgement && ` Acknowledged${acknowledgement.actorName ? ` by ${acknowledgement.actorName}` : ""} on ${when(acknowledgement.createdAt)}. Reason: ${acknowledgement.reason}`}
            {registration.alternatives && (
              <> Per-person (best match) {money(registration.alternatives.perPersonCents)}; prorated {money(registration.alternatives.proratedCents)}.</>
            )}
            {review.acknowledged && review.choice && <> Billing the {review.choice === "PER_PERSON" ? "per-person figure" : "prorated figure"}.</>}
            {isLive && !review.acknowledged && <> <AcknowledgeForm alternatives={registration.alternatives} eventId={eventId} registrationId={registration.registrationId} /></>}
          </small>
        )}
        <details>
          <summary>People ({registration.people.length})</summary>
          <ul>
            {registration.people.map((person) => (
              <li key={person.attendeeId}>
                <strong>{person.name}</strong> · {personStateLabel(person.state)}
                {person.transferredFrom ? ` · Transferred from ${person.transferredFrom}` : ""}
                {person.billable ? ` · ${money(person.chargeCents)}${person.lateRate ? " (late price)" : ""}` : " · not billed"}
                {person.addedAfterSubmission ? " · added after submission" : ""}
                {person.substituted ? " · substituted" : ""}
                {person.correction && (
                  <small>
                    {" "}{correctionLabel(person.correction.kind)}
                    {correctionDetails[person.correction.id]
                      ? `${correctionDetails[person.correction.id]!.actorName ? ` by ${correctionDetails[person.correction.id]!.actorName}` : ""} on ${when(correctionDetails[person.correction.id]!.createdAt)}. Reason: ${correctionDetails[person.correction.id]!.reason}`
                      : ""}
                  </small>
                )}
                {isLive && <CorrectionForm attended={person.billable} attendeeId={person.attendeeId} eventId={eventId} hasCorrection={person.correction !== null} personName={person.name} />}
              </li>
            ))}
          </ul>
          <small>
            Charges for attended people {money(registration.components.personChargesCents)}
            {registration.components.registrationChargeCents > 0 ? ` · registration-level charges ${money(registration.components.registrationChargeCents)}` : ""}
            {registration.credits.map((credit) => ` · ${credit.label}${credit.units !== null ? ` (${credit.units} ${credit.units === 1 ? "person" : "people"})` : ""} ${money(credit.appliedCents)}`).join("")}
            {registration.promo ? ` · promo code ${registration.promo.code} ${money(registration.promo.appliedCents)}` : ""}
            {registration.components.adjustmentCents !== 0 ? ` · staff adjustments ${money(registration.components.adjustmentCents)}` : ""}
          </small>
          {registration.unattached.length > 0 && (
            <>
              <h4>Charges not tied to a person</h4>
              <small>Kept whole, not reduced by who attended (the same as the estimate).</small>
              <ul>
                {registration.unattached.map((entry, index) => (
                  <li key={`${entry.label}-${index}`}>{entry.label}: {money(entry.amountCents)}{entry.kind === "CREDIT_AS_RECORDED" ? " (credit as recorded)" : ""}</li>
                ))}
              </ul>
            </>
          )}
        </details>
      </span>
      <CountCells counts={registration.counts} />
      <span>{money(registration.estimatedCents)}</span>
      <span><strong>{money(registration.billableCents)}</strong></span>
    </div>
  );
}
