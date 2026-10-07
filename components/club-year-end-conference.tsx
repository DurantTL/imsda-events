"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { formatReportYearDueDate, yearEndProgress } from "@/modules/club-reports/year-end-domain";
import type { YearEndClubSummary } from "@/modules/club-reports/year-end-repository";
import { cardCell } from "@/components/table-card-labels";

type Row = Pick<YearEndClubSummary, "id" | "name" | "church" | "status" | "submittedAt" | "late"> & {
  totalMembership: number | null;
};

const statusText = { NONE: "Missing", DRAFT: "Draft (missing)", SUBMITTED: "Submitted" } as const;

/**
 * Every club's Year-End Report for a Pathfinder year (#607): submitted and
 * missing counts, a CSV export, and a staff-only reopen for a submitted
 * report. Counts only, no names of young people.
 */
export function ClubYearEndConference({ reportYear, initialRows }: { reportYear: string; initialRows: Row[] }) {
  const [rows, setRows] = useState(initialRows);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const progress = yearEndProgress(rows);

  async function reopen(row: Row) {
    setError("");
    setBusyId(row.id);
    try {
      const response = await fetch(`/api/admin/club-reports/year-end/${encodeURIComponent(row.id)}/${reportYear}/reopen`, { method: "POST" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { message?: string };
        setError(result.message ?? "The report could not be reopened.");
        return;
      }
      setRows((current) => current.map((item) => (item.id === row.id ? { ...item, status: "DRAFT", submittedAt: null, late: false, totalMembership: null } : item)));
    } catch {
      setError("The report could not be reopened. Check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Clubs · Pathfinder year {reportYear}</p>
          <h2>Year-End Reports</h2>
          <p>
            Due {formatReportYearDueDate(reportYear)}. <strong>{progress.submitted}</strong> submitted,{" "}
            <strong>{progress.missing}</strong> missing{progress.drafts > 0 ? ` (${progress.drafts} still a draft)` : ""}.
          </p>
        </div>
        <a className="secondary-button" href={`/api/admin/club-reports/year-end/export?year=${reportYear}`}>
          <Download aria-hidden="true" size={16} /> Export CSV
        </a>
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <div className="table-wrap">
        <table role="table" className="report-table report-table-auto table-cards">
          <thead role="rowgroup">
            <tr role="row"><th role="columnheader">Club</th><th role="columnheader">Sponsoring church</th><th role="columnheader">Status</th><th role="columnheader">Total membership</th><th role="columnheader" /></tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => (
              <tr role="row" key={row.id}>
                <td {...cardCell("Club")}>{row.name}</td>
                <td {...cardCell("Sponsoring church")}>{row.church}</td>
                <td {...cardCell("Status")}>{statusText[row.status]}{row.status === "SUBMITTED" && row.late ? " (late)" : ""}</td>
                <td {...cardCell("Total membership")}>{row.totalMembership ?? ""}</td>
                <td {...cardCell(null)}>
                  {row.status === "SUBMITTED" && (
                    <button className="secondary-button" disabled={busyId === row.id} onClick={() => reopen(row)} type="button">
                      Reopen
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
