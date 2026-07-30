import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Circle, PackageOpen, ShieldCheck } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { PrintReportButton } from "@/components/print-report-button";
import { resolveEventContext } from "@/modules/events/selection";
import { getRetreatPackets } from "@/modules/reporting/retreat-packets-repository";

export const metadata: Metadata = {
  title: "Grouped retreat packets",
  robots: { index: false, follow: false, nocache: true },
};

function dateRange(startsAt: string, endsAt: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  }).formatRange(new Date(startsAt), new Date(endsAt));
}

function paragraphs(body: string) {
  return body.split(/\n\s*\n/).map((entry) => entry.trim()).filter(Boolean);
}

export default async function RetreatPacketsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; group?: string }>;
}) {
  const query = await searchParams;
  const { event, permissions } = await resolveEventContext(query.event);
  if (!permissions.includes("VIEW_REPORTS")) {
    return <AccessRestricted title="Retreat packets are restricted" detail="Ask an event administrator for report access." />;
  }
  const packets = await getRetreatPackets(event.id);
  if (!packets) {
    return <AccessRestricted title="Event unavailable" detail="The selected event could not be loaded." />;
  }
  const selectedGroups = query.group
    ? packets.groups.filter((group) => group.id === query.group)
    : packets.groups;
  const eventQuery = `event=${encodeURIComponent(event.id)}`;

  return (
    <section className="page-stack retreat-packet-workspace">
      <div className="page-intro retreat-packet-intro">
        <div>
          <p className="eyebrow">Event-day preparation</p>
          <h2>Grouped retreat packets</h2>
          <p>Print a cover and one operational packet per church, club, household, or registration group.</p>
        </div>
        <div className="intro-actions">
          <Link className="secondary-button" href={`/more/reports?${eventQuery}`}>Back to reports</Link>
          <PrintReportButton label={query.group ? "Print this packet" : "Print all packets"} />
        </div>
      </div>

      <div className="report-safety-note">
        <ShieldCheck aria-hidden="true" size={19} />
        <p><strong>Operational information only.</strong> Medical, allergy, accessibility, dietary free text, and other sensitive answers are excluded from every packet.</p>
      </div>

      <nav className="retreat-packet-selector" aria-label="Choose retreat packet">
        <Link className={!query.group ? "active" : ""} href={`/more/reports/packets?${eventQuery}`}>All groups</Link>
        {packets.groups.map((group) => (
          <Link className={query.group === group.id ? "active" : ""} href={`/more/reports/packets?${eventQuery}&group=${encodeURIComponent(group.id)}`} key={group.id}>
            {group.label}
          </Link>
        ))}
      </nav>

      {!query.group && (
        <article className="retreat-packet-sheet retreat-packet-cover">
          <header>
            <PackageOpen size={34} aria-hidden="true" />
            <div><p>IMSDA Events</p><h1>{packets.event.name}</h1></div>
          </header>
          <dl>
            <div><dt>Dates</dt><dd>{dateRange(packets.event.startsAt, packets.event.endsAt, packets.event.timezone)}</dd></div>
            <div><dt>Location</dt><dd>{packets.event.location ?? "See event team"}</dd></div>
            <div><dt>Groups</dt><dd>{packets.groups.length}</dd></div>
            <div><dt>Expected attendees</dt><dd>{packets.summary.attendees}</dd></div>
          </dl>
          {packets.event.contentSections.filter((section) => section.kind === "RICH_TEXT").map((section) => (
            <section key={section.id}><h2>{section.title}</h2>{paragraphs(section.body).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</section>
          ))}
          <footer>{packets.event.supportContact ?? "Contact the registration desk for assistance."}</footer>
        </article>
      )}

      {selectedGroups.map((group) => (
        <article className="retreat-packet-sheet retreat-group-packet" key={group.id}>
          <header>
            <div><p>{packets.event.name}</p><h1>{group.label}</h1><small>{group.fieldLabel ? `Grouped by ${group.fieldLabel}` : "Individual / ungrouped registrations"}</small></div>
            <strong>{group.attendees.length} {group.attendees.length === 1 ? "attendee" : "attendees"}</strong>
          </header>

          <section>
            <h2>Registration contacts</h2>
            <table>
              <thead><tr><th>Confirmation</th><th>Contact</th><th>Email / phone</th><th>Arrival</th></tr></thead>
              <tbody>{group.registrations.map((registration) => (
                <tr key={registration.id}>
                  <td>{registration.confirmationCode}</td>
                  <td>{registration.accountHolderName}</td>
                  <td>{registration.email}<br />{registration.phone}</td>
                  <td>{registration.checkedInCount}/{registration.attendeeCount}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>

          <section>
            <h2>Attendee checklist</h2>
            <table>
              <thead><tr><th>Arrived</th><th>Attendee</th><th>Type</th><th>Shirt</th><th>Assigned sessions</th></tr></thead>
              <tbody>{group.attendees.map((attendee) => (
                <tr key={attendee.id}>
                  <td>{attendee.checkedIn ? <CheckCircle2 size={16} aria-label="Checked in" /> : <Circle size={16} aria-label="Not checked in" />}</td>
                  <td><strong>{attendee.lastName}, {attendee.firstName}</strong><br /><small>{attendee.confirmationCode}</small></td>
                  <td>{attendee.attendeeType}</td>
                  <td>{attendee.shirtSize ?? "Needed"}</td>
                  <td>{attendee.assignments.length > 0
                    ? attendee.assignments.map((assignment) => <span className="packet-assignment" key={assignment.label}>{assignment.label}: <strong>{assignment.option}</strong></span>)
                    : "Not assigned"}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>

          {(group.mealCounts.length > 0 || group.housingCounts.length > 0) && (
            <section className="retreat-packet-counts">
              <h2>Group planning totals</h2>
              <div>
                {group.mealCounts.map((field) => <article key={field.label}><h3>{field.label}</h3><p>{field.values.join(" · ")}</p></article>)}
                {group.housingCounts.map((field) => <article key={field.label}><h3>{field.label}</h3><p>{field.values.join(" · ")}</p></article>)}
              </div>
            </section>
          )}

          <footer>Printed {new Date().toLocaleString()} · Protect this operational packet and shred it after use.</footer>
        </article>
      ))}

      {selectedGroups.length === 0 && <div className="empty-state panel"><PackageOpen size={26} aria-hidden="true" /><h3>No matching packet</h3><p>Active attendees will appear after registration data is available.</p></div>}
    </section>
  );
}
