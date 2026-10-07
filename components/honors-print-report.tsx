import type { ClubHonorCount, MemberCompletedHonor } from "@/modules/reporting/director-exports";

/**
 * The printable honors report (#819), in one of two shapes. The whole-club
 * shape takes only honor names and counts, so no person's name or date can
 * reach its markup. The one-person shape lists that member's completed honors.
 */
export type HonorsPrintReportProps =
  | { scope: "CLUB"; clubName: string; clubYear: string; honors: readonly ClubHonorCount[] }
  | { scope: "MEMBER"; clubName: string; clubYear: string; memberLabel: string; honors: readonly MemberCompletedHonor[] };

export function HonorsPrintReport(props: HonorsPrintReportProps) {
  if (props.scope === "CLUB") {
    return (
      <div className="report-table-wrap">
        <h3>Completed honors, whole club</h3>
        {props.honors.length === 0 ? (
          <p className="muted">No completed honors yet.</p>
        ) : (
          <table aria-label="Completed honors with the number of members who completed each" className="report-table honors-report-table">
            <thead><tr><th>Honor</th><th>Members completed</th></tr></thead>
            <tbody>
              {props.honors.map((honor) => (
                <tr key={honor.honorName}><td>{honor.honorName}</td><td>{honor.count}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }
  return (
    <div className="report-table-wrap">
      <h3>Completed honors: <span translate="no">{props.memberLabel}</span></h3>
      {props.honors.length === 0 ? (
        <p className="muted">No completed honors for this member yet.</p>
      ) : (
        <table aria-label="Completed honors for this member" className="report-table honors-report-table">
          <thead><tr><th>Honor</th><th>Completed</th></tr></thead>
          <tbody>
            {props.honors.map((honor) => (
              <tr key={honor.honorName}><td>{honor.honorName}</td><td>{honor.completionDate || "No date"}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
