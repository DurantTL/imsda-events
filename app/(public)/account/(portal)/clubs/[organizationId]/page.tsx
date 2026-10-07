import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleAlert, FileText } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { ClubNextTaskCard } from "@/components/club-next-task";
import { ClubYearTiles } from "@/components/club-year-tiles";
import { clubPortalComplianceReminderCounts } from "@/modules/background-checks/repository";
import { complianceReminders } from "@/modules/background-checks/domain";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { getRosterAccessStateForPage, type ClubActor } from "@/modules/club-rosters/access";
import { clubYearFor, rosterYearSummary } from "@/modules/club-rosters/domain";
import { pickClubNextTask } from "@/modules/club-rosters/home-next-task";
import { listRoster } from "@/modules/club-rosters/repository";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { clubEventRegistrationSteps, listClubEvents } from "@/modules/club-registrations/repository";
import { calendarDateIn } from "@/modules/calendar/domain";
import { formatDueDate, isLockedForClub, monthlyReportProgress, reportDueDate, reportMonthLabel, reportableMonths } from "@/modules/club-reports/domain";
import { getClubReportYear } from "@/modules/club-reports/repository";
import { honorYearSummary } from "@/modules/honors/member-honor-domain";
import { listClubHonorsPage } from "@/modules/honors/member-honor-repository";
import { listDirectedClubs } from "@/modules/organizations/director-access";
import { clubDirectorRoleLabels, clubRoleDescriptions } from "@/modules/organizations/director-grants-domain";

export const metadata: Metadata = { title: "Home" };
export const dynamic = "force-dynamic";

/** Only when there's somewhere else to go (#428): a single-club director has nowhere "all clubs" would take them. */
async function allMyClubsLink(actor: ClubActor | null) {
  // A staff "act as" director (#442) has one club and no attendee account to
  // list clubs for; an attendee cookie on the same browser isn't theirs to use.
  if (actor?.kind === "STAFF_ACTING") return null;
  const accountId = actor?.accountId ?? (await getCurrentAttendee()).account?.id;
  if (!accountId) return null;
  const clubs = await listDirectedClubs(accountId);
  return clubs.length > 1 ? <BackLink href="/account/clubs">All my clubs</BackLink> : null;
}

/** Where the club stands at a glance, and the next thing to do. */
export default async function ClubHomePage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state === "NO_ROSTER") {
    // A reporter (#375): no roster, no registrations, just monthly reports (#377).
    return (
      <>
        {await allMyClubsLink(null)}
        <section className="public-manage-card" aria-labelledby="club-role-heading">
          <div className="public-manage-card-heading">
            <p className="public-registration-eyebrow">Your role: {clubDirectorRoleLabels[access.club.role]}</p>
            <h2 id="club-role-heading">Monthly reports</h2>
          </div>
          <p className="public-manage-empty">
            <FileText size={17} aria-hidden="true" /> {clubRoleDescriptions[access.club.role]}
          </p>
          <Link className="primary-button club-event-action" href={`/account/clubs/${organizationId}/records`}>
            Open Monthly Records <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </section>
      </>
    );
  }
  if (access.state !== "OPEN") return null;

  const base = `/account/clubs/${organizationId}`;
  const now = new Date();
  const clubYear = clubYearFor(now);
  const [members, events, reportYear, clubsLink, compliance, honorRows] = await Promise.all([
    listRoster(organizationId, clubYear),
    listClubEvents(organizationId),
    access.capabilities.submitReports ? getClubReportYear(organizationId, clubYear) : Promise.resolve(null),
    allMyClubsLink(access.actor),
    // Only for roles that already see the roster's Sterling Volunteers column (#479).
    clubPortalComplianceReminderCounts(organizationId, clubYear, access.capabilities),
    // Honors are visible to anyone who reaches this page: the roster's own gate already applies (#486).
    listClubHonorsPage(organizationId, clubYear),
  ]);
  const active = members.filter((member) => member.status === "ACTIVE");
  const registered = events.filter((event) => event.registration);
  const open = events.filter((event) => !event.registration && event.available && event.phase === "OPEN");
  const roster = rosterYearSummary(members);
  const honors = honorYearSummary(honorRows, clubYear);
  const reportProgress = reportYear
    ? monthlyReportProgress(
      clubYear,
      now,
      new Set(reportYear.reports.filter((report) => report.status === "SUBMITTED").map((report) => report.reportMonth)),
    )
    : null;

  const steps: Array<{ key: string; text: string; href: string; action: string; danger?: boolean }> = [];
  // Each step's deadline, worded for the Next task card (#743). A step with none says "No deadline".
  const deadlines: Record<string, string> = {};
  if (active.length === 0) {
    steps.push({ key: "roster", text: "Add your club members to this year's roster.", href: `${base}/roster`, action: "Add people" });
  }
  if (reportYear) {
    // Last month's report, while it can still be submitted on time.
    const submitted = new Set(reportYear.reports.map((report) => report.reportMonth));
    for (const month of reportableMonths(clubYear, now)) {
      if (submitted.has(month) || isLockedForClub(month, now) || reportDueDate(month).slice(0, 7) !== calendarDateIn(now).slice(0, 7)) continue;
      steps.push({
        key: `report-${month}`,
        text: `The ${reportMonthLabel(month)} monthly report is due ${formatDueDate(reportDueDate(month))}.`,
        href: `${base}/records?month=${month}`,
        action: "Open report",
      });
      // A report locks for the club the day after it is due, so only a due-today report is listed; the passed-date wording is a guard.
      const due = reportDueDate(month);
      deadlines[`report-${month}`] = due < calendarDateIn(now) ? `Overdue since ${formatDueDate(due)}` : `Due ${formatDueDate(due)}`;
    }
  }
  steps.push(...clubEventRegistrationSteps(events, base));
  for (const event of events) {
    if (event.registrationClosesOn) deadlines[event.id] = `Register by ${formatCalendarDate(event.registrationClosesOn)}`;
  }
  // Flags only, never blocks registration (#405, #479).
  if (compliance) {
    for (const reminder of complianceReminders(compliance, `${base}/roster`)) {
      steps.push({ key: reminder.key, text: reminder.text, href: reminder.href, action: "Open roster", danger: true });
    }
  }
  // Picked after every step is in, so a red Sterling Volunteers item can be the next task (#743).
  const nextTask = pickClubNextTask(steps, deadlines);

  return (
    <>
      {clubsLink}
      {/* The next task and its deadline come before the statistics (#743). */}
      <ClubNextTaskCard next={nextTask} />
      <ClubYearTiles
        // Sterling Volunteers problems live only in "What's next" below, in red (#644); no tile.
        compliance={null}
        complianceHref={`${base}/roster`}
        events={{ open: open.length, registered: registered.length }}
        eventsHref={`${base}/events`}
        honors={honors}
        honorsHref={`${base}/honors`}
        reports={reportProgress}
        reportsHref={`${base}/records`}
        roster={roster}
        rosterHref={`${base}/roster`}
      />

      {/* The next task is the card above, so the list holds only what comes after it. */}
      {nextTask && nextTask.others.length > 0 && <section className="public-manage-card" aria-labelledby="club-next-heading">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">What&apos;s next</p>
          <h2 id="club-next-heading">To do</h2>
        </div>
        <ul className="public-manage-club-list">
            {nextTask.others.map((step) => (
              <li className={step.danger ? "club-step-danger" : undefined} key={step.key}>
                <CircleAlert size={17} aria-hidden="true" />
                <span>
                  {step.danger && <small className="club-step-flag">Sterling Volunteers</small>}
                  <strong>{step.text}</strong>
                </span>
                <Link className="secondary-button club-event-action" href={step.href}>
                  {step.action} <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </li>
            ))}
        </ul>
      </section>}

      {registered.length > 0 && (
        <section className="public-manage-card" aria-labelledby="club-registered-heading">
          <div className="public-manage-card-heading">
            <p className="public-registration-eyebrow">Registered</p>
            <h2 id="club-registered-heading">Your club is going to</h2>
          </div>
          <ul className="public-manage-club-list">
            {registered.map((event) => (
              <li key={event.id}>
                <CheckCircle2 size={17} aria-hidden="true" />
                <span>
                  <strong>{event.name}</strong>
                  <small>
                    {event.multipleTeams && event.teams.length > 0
                      ? `${event.teams.length} ${event.teams.length === 1 ? "team" : "teams"} · ${event.teams.reduce((sum, team) => sum + team.attendeeCount, 0)} going`
                      : `${event.registration?.attendeeCount} going · classes and details`}
                  </small>
                </span>
                <Link className="secondary-button club-event-action" href={`${base}/events/${event.id}`}>
                  Open <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
