import type { MemberClassHistory as History } from "@/modules/earned-awards/order-source";
import { cardCell } from "@/components/table-card-labels";

const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * A member's class history (#791), read-only: completed classes with the date
 * recorded, and the class they are working on. Class levels and dates only.
 * Listed in class order, Friend first.
 */
export function MemberClassHistory({ history }: { history: Pick<History, "firstName" | "lastName" | "entries"> }) {
  return (
    <section className="public-manage-card page-stack">
      <h2 translate="no">Class history: {history.firstName} {history.lastName}</h2>
      <p className="field-help">Classes recorded as completed, and the class this member is working on now. Listed in class order, Friend first.</p>
      {history.entries.length === 0 ? (
        <p className="report-empty">No classes are recorded for this member yet.</p>
      ) : (
        <div className="report-table-wrap">
          <table role="table" className="report-table table-cards">
            <caption className="sr-only">Class history for {history.firstName} {history.lastName}</caption>
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">Class</th>
                <th role="columnheader" scope="col">Status</th>
                <th role="columnheader" scope="col">Completed</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {history.entries.map((entry) => (
                <tr role="row" key={entry.classLevel}>
                  <th role="rowheader" scope="row">{entry.classLabel}</th>
                  <td {...cardCell("Status")}>{entry.status === "COMPLETED" ? "Completed" : "In progress"}</td>
                  <td {...cardCell("Completed")}>{entry.completedOn ? dateLabel(entry.completedOn) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
