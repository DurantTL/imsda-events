import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import type { BackgroundFlag } from "@/modules/background-checks/repository";

/** The red flag for an adult with no current background check (#388). Never shown to clubs. */
export function BackgroundCheckBadge({ state }: { state?: "MISSING" | "EXPIRED" }) {
  return (
    <span className="status-chip coral background-check-badge" title={state === "EXPIRED" ? "Their Sterling Volunteers check has expired." : "No Sterling Volunteers check on file."}>
      <ShieldAlert aria-hidden="true" size={12} /> Background check needed
    </span>
  );
}

/**
 * Everyone at a youth or children's event missing a current check. Staff and
 * event managers only. `registrationHref` links a row to the registration.
 */
export function BackgroundCheckList({
  people,
  registrationHref,
  showClub = true,
}: {
  people: BackgroundFlag[];
  registrationHref?: { base: string; query: string };
  showClub?: boolean;
}) {
  if (people.length === 0) {
    return <p className="report-empty">Every adult registered has a current background check.</p>;
  }
  return (
    <div className="report-table-wrap">
      <table className="report-table roster-table">
        <caption className="sr-only">Adults needing a background check</caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            {showClub && <th scope="col">Club</th>}
            <th scope="col">Check</th>
            <th scope="col">Registration</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <tr key={person.attendeeId}>
              <th scope="row" translate="no">
                {person.lastName}, {person.firstName}
                <small className="quiet-copy"> · {person.attendeeType}</small>
              </th>
              {showClub && <td translate="no">{person.clubName ?? "—"}</td>}
              <td>
                <BackgroundCheckBadge state={person.state} />
                <small className="quiet-copy"> {person.state === "EXPIRED" ? `Expired ${person.expiresOn}` : "None on file"}</small>
              </td>
              <td>
                {registrationHref
                  ? <Link className="report-record-link" href={`${registrationHref.base}?${registrationHref.query}&registration=${encodeURIComponent(person.registrationId)}`}>{person.confirmationCode}</Link>
                  : person.confirmationCode}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
