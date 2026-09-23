"use client";

import Link from "next/link";
import { useState } from "react";
import { Download } from "lucide-react";
import { clubYearMonths, isLockedForClub, yearToDate } from "@/modules/club-reports/domain";
import type { ClubYearSummary } from "@/modules/club-reports/repository";

const shortMonth = (month: string) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

/** Every club's monthly points for a club year (#377): missing reports, the registration bonus, and year to date. */
export function ClubReportsConference({
  clubYear,
  initialClubs,
  now,
  viewOnlyReportHref,
}: {
  clubYear: string;
  initialClubs: ClubYearSummary[];
  now: string;
  /**
   * Event managers (#387) see this view only: no export, no registration
   * ticks, and only submitted reports open, at this address.
   */
  viewOnlyReportHref?: { base: string; query: string };
}) {
  const viewOnly = Boolean(viewOnlyReportHref);
  const [clubs, setClubs] = useState(initialClubs);
  const [error, setError] = useState("");
  const months = clubYearMonths(clubYear);
  const today = new Date(now);

  async function toggleRegistration(club: ClubYearSummary, registrationOnTime: boolean) {
    setError("");
    setClubs((current) => current.map((item) => (item.id === club.id ? { ...item, registrationOnTime } : item)));
    const response = await fetch("/api/admin/club-reports/standing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: club.id, clubYear, registrationOnTime }),
    });
    if (!response.ok) {
      setClubs((current) => current.map((item) => (item.id === club.id ? { ...item, registrationOnTime: !registrationOnTime } : item)));
      const result = await response.json().catch(() => ({})) as { message?: string };
      setError(result.message ?? "The registration standing could not be saved.");
    }
  }

  const missingTotal = clubs.reduce((sum, club) => sum + months.filter((month) => !club.reports[month] && isLockedForClub(month, today)).length, 0);

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Clubs · {clubYear}</p>
          <h2>Monthly reports</h2>
          <p>
            Points per club and month. <strong>Missing</strong> means the due date (the 10th of the next month) has passed with no
            report. Tick <em>Registration</em> when a club&apos;s yearly registration came in on time; it adds 1,500 points.
            {viewOnly ? "Select a submitted month to view that report." : "Select a month to open or file that report."}
          </p>
        </div>
        {!viewOnly && (
          <div className="intro-actions">
            <a className="secondary-button" href={`/api/admin/club-reports/export?year=${encodeURIComponent(clubYear)}`}>
              <Download aria-hidden="true" size={15} /> Download CSV
            </a>
          </div>
        )}
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <p className="field-help">{clubs.length} active clubs · {missingTotal} missing reports so far.</p>
      {clubs.length === 0 ? (
        <div className="panel"><p className="report-empty">No active clubs yet.</p></div>
      ) : (
        <div className="report-table-wrap club-reports-grid">
          <table className="report-table">
            <caption className="sr-only">Monthly report points by club for {clubYear}</caption>
            <thead>
              <tr>
                <th scope="col">Club</th>
                {months.map((month) => <th key={month} scope="col">{shortMonth(month)}</th>)}
                <th scope="col">Registration</th>
                <th scope="col">Year to date</th>
              </tr>
            </thead>
            <tbody>
              {clubs.map((club) => (
                <tr key={club.id}>
                  <th scope="row" translate="no">{club.name}{club.church && <small>{club.church}</small>}</th>
                  {months.map((month) => {
                    const report = club.reports[month];
                    const future = month > now.slice(0, 7);
                    const href = viewOnlyReportHref
                      ? `${viewOnlyReportHref.base}/${encodeURIComponent(club.id)}/${month}${viewOnlyReportHref.query}`
                      : `/admin/clubs/reports/${encodeURIComponent(club.id)}/${month}`;
                    if (report) {
                      return <td key={month}><Link href={href}>{report.totalPoints}</Link>{!report.onTime && <small> late</small>}</td>;
                    }
                    if (future) return <td key={month} className="club-reports-future">—</td>;
                    if (viewOnly) {
                      return <td key={month} className={isLockedForClub(month, today) ? "club-reports-missing" : "club-reports-due"}>{isLockedForClub(month, today) ? "Missing" : "Due"}</td>;
                    }
                    return (
                      <td key={month}>
                        {isLockedForClub(month, today)
                          ? <Link className="club-reports-missing" href={href}>Missing</Link>
                          : <Link className="club-reports-due" href={href}>Due</Link>}
                      </td>
                    );
                  })}
                  <td>
                    {viewOnly
                      ? (club.registrationOnTime ? "On time" : "—")
                      : (
                        <input
                          aria-label={`${club.name} yearly registration on time`}
                          checked={club.registrationOnTime}
                          onChange={(event) => void toggleRegistration(club, event.target.checked)}
                          type="checkbox"
                        />
                      )}
                  </td>
                  <td><strong>{yearToDate(Object.values(club.reports), club.registrationOnTime).toLocaleString("en-US")}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
