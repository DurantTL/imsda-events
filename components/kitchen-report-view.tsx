import { Download } from "lucide-react";
import { PrintReportButton } from "@/components/print-report-button";
import type { KitchenReport } from "@/modules/registrations/kitchen-report";

/** The kitchen report (#787): counts and answers as typed, no names. Shared by the staff and Area Coordinator pages. */
export function KitchenReportView({ eventName, report, csvHref }: { eventName: string; report: KitchenReport; csvHref: string }) {
  return (
    <section className="page-stack kitchen-report">
      <div className="page-intro">
        <div>
          <p className="eyebrow" translate="no">{eventName}</p>
          <h2>Kitchen report</h2>
          <p>
            Confirmed registrations only. {report.totalPeople} {report.totalPeople === 1 ? "person" : "people"} counted, {report.peopleWithNeeds} with a dietary need.
            Answers are shown as typed and are not linked to anyone.
          </p>
        </div>
        <div className="intro-actions kitchen-report-actions">
          <a className="secondary-button" href={csvHref}><Download aria-hidden="true" size={16} /> Download CSV</a>
          <PrintReportButton label="Print" />
        </div>
      </div>

      <section className="panel" aria-label="Meal types">
        <h3>Meal types</h3>
        <div className="report-table-wrap"><table className="report-table report-table-auto">
          <thead><tr><th scope="col">Meal type</th><th scope="col">People</th></tr></thead>
          <tbody>
            {report.meals.map((meal) => <tr key={meal.value}><th scope="row">{meal.label}</th><td>{meal.count}</td></tr>)}
          </tbody>
        </table></div>
      </section>

      <section className="panel" aria-label="Dietary needs">
        <h3>Dietary needs</h3>
        <p className="field-help">People with any dietary need: <strong>{report.peopleWithNeeds}</strong>. One person can give more than one answer.</p>
        <div className="report-table-wrap"><table className="report-table report-table-auto">
          <thead><tr><th scope="col">Answer</th><th scope="col">People</th></tr></thead>
          <tbody>
            {report.needs.length === 0 && <tr><td colSpan={2}>No dietary needs reported.</td></tr>}
            {report.needs.map((need) => <tr key={need.answer}><td>{need.answer}</td><td>{need.count}</td></tr>)}
          </tbody>
        </table></div>
      </section>
    </section>
  );
}
