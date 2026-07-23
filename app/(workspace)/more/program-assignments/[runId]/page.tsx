import type { Metadata } from "next";
import Link from "next/link";
import { Download, ShieldCheck } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { PrintReportButton } from "@/components/print-report-button";
import { resolveEventContext } from "@/modules/events/selection";
import { canManageProgramAssignments } from "@/modules/program-assignments/access";
import { getAppliedAssignmentRoster } from "@/modules/program-assignments/repository";

export const metadata: Metadata = { title: "Assignment roster" };

function rankLabel(rank: number | null) {
  if (rank === 1) return "1st choice";
  if (rank === 2) return "2nd choice";
  if (rank) return `Choice ${rank}`;
  return "Unassigned";
}

export default async function ProgramAssignmentRosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const [{ runId }, { event: requested }] = await Promise.all([params, searchParams]);
  const { event, permissions } = await resolveEventContext(requested);
  if (!canManageProgramAssignments(permissions)) {
    return (
      <AccessRestricted
        title="Assignment roster is restricted"
        detail="Ask an event administrator for registration or form-management access before opening this roster."
      />
    );
  }
  const roster = await getAppliedAssignmentRoster(event.id, runId);
  if (!roster) {
    return (
      <AccessRestricted
        title="Assignment roster not found"
        detail="This run does not belong to the selected event, or it is no longer available."
      />
    );
  }
  const groups = new Map<string, typeof roster.assignments>();
  for (const assignment of roster.assignments) {
    const label = assignment.assignedOption ?? "Unassigned";
    const group = groups.get(label) ?? [];
    group.push(assignment);
    groups.set(label, group);
  }

  return (
    <section className="page-stack assignment-roster-page">
      <div className="page-intro assignment-roster-intro">
        <div>
          <p className="eyebrow">Frozen assignment run</p>
          <h2>{roster.fieldLabel}</h2>
          <p>{roster.eventName} · {roster.formName} version {roster.formVersionNumber} · applied {new Date(roster.appliedAt).toLocaleString()} by {roster.appliedByName}</p>
        </div>
        <div className="intro-actions assignment-print-actions">
          <Link className="secondary-button" href={`/more/program-assignments?event=${encodeURIComponent(event.id)}`}>Back to assignments</Link>
          <a className="secondary-button" href={`/api/events/${encodeURIComponent(event.id)}/program-assignments/${encodeURIComponent(roster.id)}/roster`}><Download aria-hidden="true" size={15} /> CSV</a>
          <PrintReportButton />
        </div>
      </div>
      <div className="assignment-safety-note">
        <ShieldCheck aria-hidden="true" size={19} />
        <p><strong>Immutable roster.</strong> This printout is the exact applied run. Later registrations or form changes do not alter it.</p>
      </div>
      {[...groups.entries()].map(([option, assignments]) => (
        <section className="panel assignment-roster-group" key={option}>
          <div className="section-heading">
            <div><p className="eyebrow">{option === "Unassigned" ? "Needs staff review" : "Room roster"}</p><h2>{option}</h2></div>
            <span className="count-badge">{assignments.length} {assignments.length === 1 ? "person" : "people"}</span>
          </div>
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">{option} assignment roster</caption>
              <thead><tr><th scope="col">Attendee</th><th scope="col">Result</th><th scope="col">Type</th><th scope="col">Registration</th></tr></thead>
              <tbody>
                {assignments.map((assignment) => (
                  <tr key={assignment.attendeeId}>
                    <th scope="row">{assignment.lastName}, {assignment.firstName}</th>
                    <td>{assignment.unassignedReason === "NO_RANKED_CHOICES"
                      ? "No ranking submitted"
                      : assignment.unassignedReason === "CAPACITY_FULL"
                        ? "No ranked room available"
                        : rankLabel(assignment.preferenceRank)}</td>
                    <td>{assignment.attendeeType}</td>
                    <td>{assignment.confirmationCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </section>
  );
}
