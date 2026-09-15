import type { Metadata } from "next";
import Link from "next/link";
import {
  CopyCheck,
  Mail,
  Phone,
  ShieldCheck,
  TriangleAlert,
  UserRoundSearch,
  UsersRound,
} from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { resolveEventContext } from "@/modules/events/selection";
import {
  buildDuplicateReport,
  type DuplicateMatchConfidence,
} from "@/modules/registrations/duplicate-detection";
import { listRegistrations } from "@/modules/registrations/repository";

export const metadata: Metadata = { title: "Duplicate finder" };

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(cents / 100);
}

function ConfidenceChip({ confidence }: { confidence: DuplicateMatchConfidence }) {
  return (
    <span className={`status-chip ${confidence === "LIKELY" ? "gold" : "purple"}`}>
      {confidence === "LIKELY" ? "Likely duplicate" : "Possible duplicate"}
    </span>
  );
}

function registrationHref(eventId: string, registrationId: string) {
  return `/people?event=${encodeURIComponent(eventId)}&registration=${encodeURIComponent(registrationId)}`;
}

export default async function DuplicateFinderPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const query = await searchParams;
  const { event, permissions } = await resolveEventContext(query.event);
  if (!permissions.includes("VIEW_SENSITIVE_DATA")) {
    return (
      <AccessRestricted
        title="The duplicate finder is restricted"
        detail="Reviewing possible duplicates means reading attendee names and contact details, which your event role does not include."
      />
    );
  }

  const registrations = await listRegistrations(event.id);
  const report = buildDuplicateReport(registrations);
  const nothingFound = report.attendeeGroups.length === 0
    && report.registrationGroups.length === 0;

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Registration integrity</p>
          <h2>Duplicate finder</h2>
          <p>
            People and registrations that look like the same person entered
            more than once for {event.name}. Nothing here is changed
            automatically — open a registration to decide what should happen.
          </p>
        </div>
        <div className="intro-actions">
          <Link
            className="secondary-button"
            href={`/people?event=${encodeURIComponent(event.id)}`}
          >
            Back to people
          </Link>
        </div>
      </div>

      <section className="finance-summary" aria-label="Duplicate scan summary">
        <article className="finance-stat">
          <span><UsersRound aria-hidden="true" size={18} /></span>
          <small>Active registrations scanned</small>
          <strong>{report.scannedRegistrationCount}</strong>
        </article>
        <article className="finance-stat">
          <span><UserRoundSearch aria-hidden="true" size={18} /></span>
          <small>Attendees scanned</small>
          <strong>{report.scannedAttendeeCount}</strong>
        </article>
        <article className={report.attendeeGroups.length > 0 ? "finance-stat warning" : "finance-stat muted"}>
          <span><CopyCheck aria-hidden="true" size={18} /></span>
          <small>Attendees in a match</small>
          <strong>{report.duplicatedAttendeeCount}</strong>
        </article>
        <article className={report.registrationGroups.length > 0 ? "finance-stat warning" : "finance-stat muted"}>
          <span><TriangleAlert aria-hidden="true" size={18} /></span>
          <small>Contacts with several registrations</small>
          <strong>{report.registrationGroups.length}</strong>
        </article>
      </section>

      {nothingFound ? (
        <section className="panel empty-state">
          <ShieldCheck aria-hidden="true" size={24} />
          <h3>No duplicates found</h3>
          <p>
            No two active registrations share an email address, a name and
            phone number, or a name. Cancelled registrations are not scanned.
          </p>
        </section>
      ) : null}

      {report.attendeeGroups.length > 0 && (
        <section className="panel duplicate-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Same person, more than once</p>
              <h2>{report.attendeeGroups.length} attendee match{report.attendeeGroups.length === 1 ? "" : "es"}</h2>
            </div>
          </div>
          {report.attendeeGroups.map((group) => (
            <article className="duplicate-group" key={group.key}>
              <header>
                <ConfidenceChip confidence={group.confidence} />
                <strong>{group.members[0].name}</strong>
                <small>
                  {group.reason}
                  {group.withinSingleRegistration
                    ? " · repeated on one registration"
                    : ` · across ${new Set(group.members.map((member) => member.registrationId)).size} registrations`}
                </small>
              </header>
              <ul className="duplicate-member-list">
                {group.members.map((member) => (
                  <li key={member.attendeeId}>
                    <span>
                      <strong>{member.name}</strong>
                      <small>
                        {member.confirmationCode} · {member.registrationStatus.toLowerCase()} · {member.attendeeType.toLowerCase()}
                        {member.checkedIn ? " · checked in" : ""}
                        {member.balanceCents > 0 ? ` · ${money(member.balanceCents)} due` : ""}
                      </small>
                      <small className="duplicate-contact">
                        {member.email && <span><Mail aria-hidden="true" size={12} /> {member.email}</span>}
                        {member.phone && <span><Phone aria-hidden="true" size={12} /> {member.phone}</span>}
                      </small>
                    </span>
                    <Link
                      className="text-button"
                      href={registrationHref(event.id, member.registrationId)}
                    >
                      Open registration
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      )}

      {report.registrationGroups.length > 0 && (
        <section className="panel duplicate-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">One contact, several registrations</p>
              <h2>{report.registrationGroups.length} contact match{report.registrationGroups.length === 1 ? "" : "es"}</h2>
            </div>
          </div>
          <p className="quiet-copy">
            These can be legitimate — a leader registering two households books
            twice on purpose. Check the attendees before changing anything.
          </p>
          {report.registrationGroups.map((group) => (
            <article className="duplicate-group" key={group.key}>
              <header>
                <ConfidenceChip confidence={group.confidence} />
                <strong>{group.members[0].contactName}</strong>
                <small>{group.reason} · {group.members.length} registrations</small>
              </header>
              <ul className="duplicate-member-list">
                {group.members.map((member) => (
                  <li key={member.registrationId}>
                    <span>
                      <strong>{member.confirmationCode}</strong>
                      <small>
                        {member.status.toLowerCase()} · {member.attendeeCount} {member.attendeeCount === 1 ? "person" : "people"} · {money(member.totalAmountCents)} total · {money(member.balanceCents)} due
                      </small>
                      <small className="duplicate-contact">
                        {member.email && <span><Mail aria-hidden="true" size={12} /> {member.email}</span>}
                        {member.phone && <span><Phone aria-hidden="true" size={12} /> {member.phone}</span>}
                      </small>
                    </span>
                    <Link
                      className="text-button"
                      href={registrationHref(event.id, member.registrationId)}
                    >
                      Open registration
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
