import { Phone, UsersRound } from "lucide-react";
import { clubRosterAttendeeTypeLabels, clubYearFor } from "@/modules/club-rosters/domain";
import { GuardianAccessError, listGuardianContactsForClub, type ClubGuardianContact } from "@/modules/club-rosters/guardians-repository";
import { GUARDIAN_SLOTS, type GuardianRecord, type GuardianViewer } from "@/modules/club-rosters/guardians-domain";

/**
 * A club's guardian contacts, read only (#510), for the pages Area
 * Coordinators and conference staff use to look at a club. The caller passes
 * the viewer it resolved from the session (`guardians-access.ts`); the
 * repository checks it again and audits a coordinator's or staff member's
 * opening of the list. A viewer who may not read this club sees nothing.
 */
export async function ClubGuardiansPanel({
  organizationId,
  viewer,
  headingLevel = 2,
}: {
  organizationId: string;
  viewer: GuardianViewer;
  headingLevel?: 2 | 3;
}) {
  let contacts: ClubGuardianContact[];
  try {
    contacts = await listGuardianContactsForClub(viewer, organizationId, clubYearFor(new Date()));
  } catch (error) {
    if (error instanceof GuardianAccessError) return null;
    throw error;
  }
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="public-manage-card" aria-labelledby="open-club-guardians" id="open-club-guardians">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Confidential · for event care</p>
        <Heading id="open-club-guardians">Guardian contacts</Heading>
      </div>
      {contacts.length === 0 ? (
        <p className="public-manage-empty"><UsersRound size={17} aria-hidden="true" /> No guardian contacts are on file for this club yet.</p>
      ) : (
        <div className="club-guardians-table-wrap report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                {Array.from({ length: GUARDIAN_SLOTS }, (_, index) => <th key={index} scope="col">Guardian {index + 1}</th>)}
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.memberId}>
                  <th scope="row">
                    <span translate="no">{contact.firstName} {contact.lastName}</span>
                    <small> · {clubRosterAttendeeTypeLabels[contact.attendeeType as keyof typeof clubRosterAttendeeTypeLabels] ?? contact.attendeeType}</small>
                  </th>
                  {Array.from({ length: GUARDIAN_SLOTS }, (_, index) => (
                    <td key={index}><GuardianCell guardian={contact.guardians.find((guardian) => guardian.position === index + 1)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function GuardianCell({ guardian }: { guardian: GuardianRecord | undefined }) {
  if (!guardian) return <span className="quiet-copy">None on file</span>;
  return (
    <span className="club-guardian-cell">
      <strong translate="no">{guardian.name || "Name not given"}</strong>
      {guardian.relationship && <small>{guardian.relationship}</small>}
      {guardian.phone && <a href={`tel:${guardian.phone.replace(/[^0-9+]/g, "")}`} translate="no"><Phone aria-hidden="true" size={12} /> {guardian.phone}</a>}
      {guardian.email && <a href={`mailto:${guardian.email}`} translate="no">{guardian.email}</a>}
    </span>
  );
}
