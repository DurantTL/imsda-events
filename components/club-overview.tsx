import Link from "next/link";
import { CalendarDays, CheckCircle2, FileText, UserCog, UsersRound } from "lucide-react";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { listClubEvents } from "@/modules/club-registrations/repository";
import { reportMonthLabel, reportableMonths, yearToDate } from "@/modules/club-reports/domain";
import { getClubReportYear } from "@/modules/club-reports/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";
import { listClubTeam } from "@/modules/organizations/director-grants-repository";

/**
 * A club as its director sees it, view only (#386, #387): admins, this year's
 * roster, events, and monthly reports. Staff may show birth dates (audited);
 * Area Coordinators see ages only, so they get no birth-date endpoint.
 * Callers check access before rendering this.
 */
export async function ClubOverview({
  organizationId,
  birthDatesEndpoint,
  reportHref,
  reportsEditable,
}: {
  organizationId: string;
  birthDatesEndpoint?: string;
  reportHref: (month: string) => string;
  /** Staff can open and file a month with no report yet; others only view. */
  reportsEditable: boolean;
}) {
  const now = new Date();
  const clubYear = clubYearFor(now);
  const [team, members, events, reportYear] = await Promise.all([
    listClubTeam(organizationId, now),
    listRoster(organizationId, clubYear, now),
    listClubEvents(organizationId, now),
    getClubReportYear(organizationId, clubYear),
  ]);
  const active = members.filter((member) => member.status === "ACTIVE");
  const registered = events.filter((event) => event.registration);
  // A club's own draft isn't shown here as filed (#426); staff open the report itself to see or edit one.
  const submittedReports = reportYear.reports.filter((report) => report.status === "SUBMITTED");
  const reportsByMonth = new Map(submittedReports.map((report) => [report.reportMonth, report]));
  const months = reportableMonths(clubYear, now).reverse();

  return (
    <>
      <div className="club-home-stats">
        <div className="club-home-stat">
          <UsersRound size={20} aria-hidden="true" />
          <strong>{active.length}</strong>
          <span>on the {clubYear} roster</span>
        </div>
        <div className="club-home-stat">
          <CheckCircle2 size={20} aria-hidden="true" />
          <strong>{registered.length}</strong>
          <span>{registered.length === 1 ? "upcoming event registered" : "upcoming events registered"}</span>
        </div>
        <div className="club-home-stat">
          <FileText size={20} aria-hidden="true" />
          <strong>{yearToDate(reportYear.reports, reportYear.registrationOnTime)}</strong>
          <span>points this club year</span>
        </div>
      </div>

      <section className="public-manage-card" aria-labelledby="open-club-team">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Club admins</p>
          <h2 id="open-club-team">Who runs this club</h2>
        </div>
        {team.length === 0 ? (
          <p className="public-manage-empty"><UserCog size={17} aria-hidden="true" /> No one has a club role yet.</p>
        ) : (
          <ul className="public-manage-club-list">
            {team.map((member) => (
              <li key={member.id}>
                <UserCog size={17} aria-hidden="true" />
                <span>
                  <strong translate="no">{member.displayName}</strong>
                  <small>{clubDirectorRoleLabels[member.role]} · <span translate="no">{member.email}</span></small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ClubRosterWorkspace
        birthDatesEndpoint={birthDatesEndpoint}
        canSeeBirthDates={Boolean(birthDatesEndpoint)}
        clubYear={clubYear}
        initialMembers={members}
        organizationId={organizationId}
        readOnly
      />

      <section className="public-manage-card" aria-labelledby="open-club-events">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Events</p>
          <h2 id="open-club-events">Upcoming club events</h2>
        </div>
        {events.length === 0 ? (
          <p className="public-manage-empty"><CalendarDays size={17} aria-hidden="true" /> No upcoming club events are published.</p>
        ) : (
          <ul className="public-manage-club-list">
            {events.map((event) => (
              <li key={event.id}>
                {event.registration
                  ? <CheckCircle2 size={17} aria-hidden="true" />
                  : <CalendarDays size={17} aria-hidden="true" />}
                <span>
                  <strong>{event.name}</strong>
                  <small>
                    {event.registration
                      ? `Registered · ${event.registration.attendeeCount} going · ${event.registration.confirmationCode}`
                      : event.draft
                        ? `Started, not submitted · ${event.draft.selectedCount} picked`
                        : `Not registered${event.registrationClosesOn ? ` · closes ${formatCalendarDate(event.registrationClosesOn)}` : ""}`}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="public-manage-card" aria-labelledby="open-club-reports">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Club year {clubYear}</p>
          <h2 id="open-club-reports">Monthly reports</h2>
        </div>
        {months.length === 0 ? (
          <p className="public-manage-empty"><FileText size={17} aria-hidden="true" /> No reports are due yet this club year.</p>
        ) : (
          <ul className="public-manage-club-list">
            {months.map((month) => {
              const report = reportsByMonth.get(month);
              return (
                <li key={month}>
                  <FileText size={17} aria-hidden="true" />
                  <span>
                    <strong>{reportMonthLabel(month)}</strong>
                    <small>{report ? `Submitted · ${report.totalPoints} points` : "Not submitted"}</small>
                  </span>
                  {(report || reportsEditable) && (
                    <Link className="secondary-button club-event-action" href={reportHref(month)}>
                      {report ? "View report" : "Open report"}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
