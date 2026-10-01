import { HEALTH_TEXT, type HealthClubSheet } from "@/modules/coordinator-health/domain";

function formatDate(value: string | null) {
  if (!value) return "date not recorded";
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * One club event's health information (#658): per club, per attendee. Shows
 * only the fields the coordinator health view is approved to show, each marked
 * with where it came from. Server-rendered; nothing here is sent to a script.
 */
export function EventHealthSheet({ clubs }: { clubs: HealthClubSheet[] }) {
  if (clubs.length === 0) return <p className="quiet-copy">No club has registered for this event.</p>;
  return (
    <div className="event-health-sheet">
      <p className="inline-notice error" role="note"><strong>{HEALTH_TEXT.confidential}</strong></p>
      {clubs.map((club) => (
        <section className="panel" key={club.organizationId} aria-labelledby={`health-${club.organizationId}`}>
          <h3 id={`health-${club.organizationId}`} translate="no">{club.clubName}</h3>
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
                        {attendee.emergencyContacts.length === 0 ? "None on file" : (
                          <ul>
                            {attendee.emergencyContacts.map((contact, index) => (
                              <li key={index}>
                                <span translate="no">{contact.value}</span>
                                <small> ({contact.kind === "PHONE_ONLY" ? "phone only; the form has no name" : "name and phone"}; from {contact.formName}, {formatDate(contact.submittedOn)}{contact.matchedBy === "NAME" ? ", matched by name" : ""})</small>
                              </li>
                            ))}
                          </ul>
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
