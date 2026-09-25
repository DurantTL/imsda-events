import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { backgroundFlagLabels } from "@/modules/background-checks/domain";
import type { BackgroundFlag } from "@/modules/background-checks/repository";

const badgeTitles = {
  MISSING: "No background check on file.",
  EXPIRED: "Their Sterling Volunteers check has expired.",
  NOT_COMPLIANT: "The latest roster import marks them not in compliance.",
} as const;

/**
 * The red flag for an adult with no current background check (#388, #427).
 * Never shown to clubs. An "expiring soon" roster mark still counts as
 * current here, so it is never flagged.
 */
export function BackgroundCheckBadge({ state }: { state?: BackgroundFlag["state"] }) {
  return (
    <span className="status-chip coral background-check-badge" title={badgeTitles[state ?? "MISSING"]}>
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
                <small className="quiet-copy"> {person.state === "EXPIRED" ? `Expired ${person.expiresOn}` : backgroundFlagLabels[person.state]}</small>
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
