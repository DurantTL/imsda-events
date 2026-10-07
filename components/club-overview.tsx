import Link from "next/link";
import { CalendarDays, CheckCircle2, FileText, UserCog } from "lucide-react";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { ClubYearTiles } from "@/components/club-year-tiles";
import { clubComplianceReminderCounts, clubRosterComplianceStatuses } from "@/modules/background-checks/repository";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { listClubEvents } from "@/modules/club-registrations/repository";
import { monthlyReportProgress, reportMonthLabel, reportableMonths, yearToDate } from "@/modules/club-reports/domain";
import { getClubReportYear } from "@/modules/club-reports/repository";
import { clubYearFor, rosterYearSummary } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";
import { honorYearSummary } from "@/modules/honors/member-honor-domain";
import { listClubHonorsPage } from "@/modules/honors/member-honor-repository";
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
  backgroundChecks,
  complianceCounts,
  honorsHref,
  staffHonorsHref,
  rosterYear,
  portalView = false,
  headingLevel = 2,
}: {
  organizationId: string;
  /**
   * The club year the roster section shows (#541), from the staff page's
   * year choice. Defaults to the current year. Another year is read-only and
   * never offers birth dates, since the reveal route covers the current year.
   */
  rosterYear?: string;
  /** Rendered in the account portal (not the staff admin pages), so empty states can point to the conference office. */
  portalView?: boolean;
  /** Heading level of the summary tiles (see ClubYearTiles): 3 when the page has its own h2 above. */
  headingLevel?: 2 | 3;
  birthDatesEndpoint?: string;
  reportHref: (month: string) => string;
  /** Staff can open and file a month with no report yet; others only view. */
  reportsEditable: boolean;
  /**
   * Show each adult's Sterling Volunteers status (#427). Omitted for callers who
   * aren't allowed to see it at all (event managers). `includeNotes` is true only
   * for the viewers `notes-access.ts` allows: staff, and an Area Coordinator for a
   * club in their scope (#443). A club director never gets the note.
   */
  backgroundChecks?: { includeNotes: boolean };
  /**
   * Counts only, no names or notes (#479): for a viewer who isn't allowed the
   * full `backgroundChecks` column but should still see whether the club has
   * anything outstanding. Ignored when `backgroundChecks`
   * is set, since that caller already gets the fuller per-member view.
   */
  complianceCounts?: boolean;
  /**
   * The club's own Honors page, for a caller with one (an Area Coordinator,
   * #486). Omitted callers (staff, an event manager) have no separate Honors
   * page here, so the tile points at the roster's own honor chips instead.
   */
  honorsHref?: string;
  /** The conference staff's Honors page for this club: the roster's Honors button links there (#819). */
  staffHonorsHref?: string;
}) {
  const now = new Date();
  const clubYear = clubYearFor(now);
  const shownRosterYear = rosterYear ?? clubYear;
  const otherYear = shownRosterYear !== clubYear;
  const [team, members, events, reportYear, compliance, reminderCounts, honorRows] = await Promise.all([
    listClubTeam(organizationId, now),
    listRoster(organizationId, shownRosterYear, now),
    listClubEvents(organizationId, now),
    getClubReportYear(organizationId, clubYear),
    backgroundChecks ? clubRosterComplianceStatuses(organizationId, shownRosterYear, backgroundChecks) : null,
    // Counts only, no names (#479): shown even to a viewer who never gets `backgroundChecks`.
    !backgroundChecks && complianceCounts ? clubComplianceReminderCounts(organizationId, shownRosterYear) : null,
    listClubHonorsPage(organizationId, shownRosterYear),
  ]);
  const honors = honorYearSummary(honorRows, shownRosterYear);
  const registered = events.filter((event) => event.registration);
  const open = events.filter((event) => !event.registration && event.available && event.phase === "OPEN");
  // A club's own draft isn't shown here as filed (#426); staff open the report itself to see or edit one.
  const submittedReports = reportYear.reports.filter((report) => report.status === "SUBMITTED");
  const reportsByMonth = new Map(submittedReports.map((report) => [report.reportMonth, report]));
  const dueMonths = reportableMonths(clubYear, now);
  const months = [...dueMonths].reverse();
  const roster = rosterYearSummary(members);
  const complianceTile = compliance
    ? { missing: compliance.missing, notInCompliance: compliance.notInCompliance, expiringSoon: compliance.expiringSoon }
    : reminderCounts;
  const reportProgress = monthlyReportProgress(clubYear, now, new Set(submittedReports.map((report) => report.reportMonth)));

  return (
    <>
      <ClubYearTiles
        headingLevel={headingLevel}
        compliance={complianceTile}
        complianceHref="#open-club-roster"
        events={{ open: open.length, registered: registered.length }}
        eventsHref="#open-club-events"
        honors={honors}
        honorsHref={honorsHref ?? staffHonorsHref ?? "#open-club-roster"}
        reports={reportProgress}
        reportsHref="#open-club-reports"
        roster={roster}
        rosterHref="#open-club-roster"
      />
      <p className="club-year-tiles-points quiet-copy">
        <FileText size={15} aria-hidden="true" /> {yearToDate(submittedReports, reportYear.registrationOnTime)} points this club year.
      </p>

      <section className="public-manage-card" aria-labelledby="open-club-team">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Club admins</p>
          <h2 id="open-club-team">Who runs this club</h2>
        </div>
        {team.length === 0 ? (
          <p className="public-manage-empty"><UserCog size={17} aria-hidden="true" /> No club director is assigned yet.{portalView ? " Contact the conference office to have one added." : ""}</p>
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

      <div id="open-club-roster">
        {/* Keyed by year: the year links navigate client-side, and the roster's own state must not carry the last year's people over. */}
        <ClubRosterWorkspace
          key={shownRosterYear}
          birthDatesEndpoint={otherYear ? undefined : birthDatesEndpoint}
          canSeeBirthDates={Boolean(birthDatesEndpoint) && !otherYear}
          clubYear={shownRosterYear}
          complianceStatuses={compliance?.statuses}
          honorsHref={staffHonorsHref}
          honorsPopup={honorsHref ? { canRecord: false } : undefined}
          // No class history link here (#791): it opens on the club portal's gate, and the id stays off this view.
          initialMembers={members.map((member) => ({ ...member, personId: undefined }))}
          organizationId={organizationId}
          readOnly
        />
      </div>

      <section className="public-manage-card" aria-labelledby="open-club-events">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Events</p>
          <h2 id="open-club-events">Upcoming club events</h2>
        </div>
        {events.length === 0 ? (
          <p className="public-manage-empty"><CalendarDays size={17} aria-hidden="true" /> No upcoming club events are published. Check back when the conference opens registration.</p>
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
                    {event.multipleTeams && event.teams.length > 0
                      ? `${event.teams.length} ${event.teams.length === 1 ? "team" : "teams"} registered · ${event.teams.reduce((sum, team) => sum + team.attendeeCount, 0)} going`
                      : event.registration
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
          <h2 id="open-club-reports">Monthly Records</h2>
        </div>
        {months.length === 0 ? (
          <p className="public-manage-empty"><FileText size={17} aria-hidden="true" /> No reports are due yet this club year. Check back when the first month opens.</p>
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
