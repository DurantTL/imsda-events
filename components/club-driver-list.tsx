import { Car } from "lucide-react";
import type { ClubDriverEntry } from "@/modules/driver-verification/repository";

const tone = { CLEARED: "green", EXPIRING: "gold", NOT_CLEARED: "coral", NEEDS_REVIEW: "gold" } as const;

/**
 * A club's willing drivers with their clearance label (#544): "Cleared to
 * drive", "Expiring (date)", "Not cleared" or "Pending". Clearance comes from
 * the conference's background-check list; the club sees the label only,
 * never the issues text behind it (#427), and can't change it.
 */
export function ClubDriverList({ entries }: { entries: ClubDriverEntry[] }) {
  return (
    <section className="panel club-driver-list">
      <div className="section-heading">
        <div>
          <h2><Car aria-hidden="true" size={18} /> Drivers</h2>
          <p>
            Everyone who checked &quot;Willing to drive&quot; on their roster profile. Clearance comes from the
            conference&apos;s background-check list. &quot;Pending&quot; means conference staff are looking at it.
          </p>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="report-empty">No one has checked &quot;Willing to drive&quot; yet.</p>
      ) : (
        <div className="report-table-wrap">
          <table className="report-table">
            <caption className="sr-only">Willing drivers</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Clearance</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.rosterMemberId}>
                  <th scope="row" translate="no">{entry.lastName}, {entry.firstName}</th>
                  <td><span className={`status-chip ${tone[entry.status]}`}>{entry.label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
