import { HEALTH_TEXT, type HealthAttendeeRow, type HealthClubSheet } from "@/modules/coordinator-health/domain";

function formatDate(value: string | null) {
  if (!value) return "date not recorded";
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * One club event's health information (#658): per club, per attendee. Shows
 * only the fields the coordinator health view is approved to show, each marked
 * with where it came from. Server-rendered; nothing here is sent to a script.
 */
function emergencyNote(attendee: HealthAttendeeRow) {
  if (attendee.emergencyStatus === "AMBIGUOUS_NAME") return "Name matches more than one attendee — check the passenger list";
  if (attendee.emergencyStatus === "NO_CONTACT_MATCHED") return "No contact matched";
  return null;
}

export function EventHealthSheet({ clubs, clubLinks }: { clubs: HealthClubSheet[]; clubLinks?: (organizationId: string) => { view: string; sheet: string } }) {
  if (clubs.length === 0) return <p className="quiet-copy">No club has registered for this event.</p>;
  return (
    <div className="event-health-sheet">
      <p className="inline-notice error" role="note"><strong>{HEALTH_TEXT.confidential}</strong></p>
      {clubs.map((club) => (
        <section className="panel" key={`${club.organizationId}:${club.teamKey ?? ""}`} aria-labelledby={`health-${club.organizationId}${club.teamKey ? `-${club.teamKey.replace(/[^a-z0-9]+/g, "-")}` : ""}`}>
          <h3 id={`health-${club.organizationId}${club.teamKey ? `-${club.teamKey.replace(/[^a-z0-9]+/g, "-")}` : ""}`} translate="no">{club.clubName}</h3>
          {clubLinks && (
            <p className="field-help">
              <a href={clubLinks(club.organizationId).view}>This club only</a>{" · "}
              <a href={clubLinks(club.organizationId).sheet}>Printable sheet for this club</a>
            </p>
          )}
          {club.attendees.length === 0 ? <p className="quiet-copy">No attendees on this club&apos;s active registration.</p> : (
            <div className="report-table-wrap">
              <table className="report-table">
                <caption className="sr-only">{club.clubName} health information</caption>
                <thead>
                  <tr>
                    <th scope="col">Attendee</th>
                    <th scope="col">{HEALTH_TEXT.dietaryLabel}</th>
                    <th scope="col">{HEALTH_TEXT.medicalFlagLabel}</th>
                    <th scope="col">{HEALTH_TEXT.medicationsLabel}</th>
                    <th scope="col">{HEALTH_TEXT.emergencyLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {club.attendees.map((attendee) => (
                    <tr key={attendee.attendeeId}>
                      <th scope="row" translate="no">{attendee.name}</th>
                      <td translate="no">{attendee.dietary ?? "None entered"}</td>
                      <td>{attendee.medicalFlag ?? "Not answered"}</td>
                      <td>{HEALTH_TEXT.medicationsValue}</td>
                      <td>
                        {attendee.emergencyContacts.length === 0 ? (emergencyNote(attendee) ?? "None on file") : (
                          <>
                          <ul>
                            {attendee.emergencyContacts.map((contact, index) => (
                              <li key={index}>
                                <span translate="no">{contact.value}</span>
                                <small> ({contact.forThisEvent ? "for this event; " : ""}{contact.kind === "PHONE_ONLY" ? "phone only; the form has no name" : "name and phone"}; from {contact.formName}, {formatDate(contact.submittedOn)}{contact.matchedBy === "NAME" ? ", matched by name" : ""})</small>
                              </li>
                            ))}
                          </ul>
                          {emergencyNote(attendee) && <small>{emergencyNote(attendee)}</small>}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
      <p className="field-help">{HEALTH_TEXT.dietaryHelp} {HEALTH_TEXT.medicalFlagHelp} {HEALTH_TEXT.medicationsHelp}</p>
      <p className="inline-notice error" role="note"><strong>{HEALTH_TEXT.confidential}</strong></p>
    </div>
  );
}
