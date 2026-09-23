import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CalendarDays, CheckCircle2, Eye, FileText, IdCard, UserCog, UsersRound } from "lucide-react";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { getPrisma } from "@/lib/prisma";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { listClubEvents } from "@/modules/club-registrations/repository";
import { reportMonthLabel, reportableMonths, yearToDate } from "@/modules/club-reports/domain";
import { getClubReportYear } from "@/modules/club-reports/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";
import { listClubTeam } from "@/modules/organizations/director-grants-repository";

export const metadata: Metadata = { title: "Open club" };
export const dynamic = "force-dynamic";

/**
 * A club as its director sees it, for conference staff, view only (#386):
 * the club's admins, this year's roster, its events, and its monthly reports.
 * Changes are made on the staff screens linked here, never on the club's behalf.
 */
export default async function StaffOpenClubPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { organizationId } = await params;
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, name: true, isActive: true, parentOrganization: { select: { name: true } } },
  });
  if (!club || club.type !== "CLUB") notFound();

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
  const reportsByMonth = new Map(reportYear.reports.map((report) => [report.reportMonth, report]));
  const months = reportableMonths(clubYear, now).reverse();

  return (
    <section className="page-stack">
      <div className="intro-actions club-admin-links">
        <Link className="secondary-button more-back-link" href="/admin/organizations">
          Back to churches and clubs
        </Link>
        <Link className="secondary-button" href={`/admin/organizations/${organizationId}/directors`}>
          <UserCog aria-hidden="true" size={14} /> Club admins
        </Link>
        <Link className="secondary-button" href={`/admin/organizations/${organizationId}/profile`}>
          <IdCard aria-hidden="true" size={14} /> Profile
        </Link>
      </div>

      <div className="page-intro">
        <div>
          <p className="eyebrow">Open club · view only</p>
          <h2 translate="no">{club.name}</h2>
          <p>
            {club.parentOrganization ? <>Sponsored by <span translate="no">{club.parentOrganization.name}</span>. </> : null}
            {club.isActive ? "" : "This club is inactive. "}
            This is what the club&apos;s director sees. Nothing can be changed here; showing birth dates is recorded.
          </p>
        </div>
      </div>

      <p className="inline-notice" role="status">
        <Eye aria-hidden="true" size={14} /> View only. Change club admins or the profile with the buttons above, and file
        or correct reports from Monthly reports.
      </p>

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
        birthDatesEndpoint={`/api/admin/organizations/${encodeURIComponent(organizationId)}/roster/birth-dates`}
        canSeeBirthDates
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
                  <Link className="secondary-button club-event-action" href={`/admin/clubs/reports/${organizationId}/${month}`}>
                    {report ? "View report" : "Open report"}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
