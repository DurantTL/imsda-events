import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CalendarDays, CheckCircle2, CircleAlert, FileText, UsersRound } from "lucide-react";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { listClubEvents } from "@/modules/club-registrations/repository";
import { calendarDateIn } from "@/modules/calendar/domain";
import { formatDueDate, isLockedForClub, reportDueDate, reportMonthLabel, reportableMonths } from "@/modules/club-reports/domain";
import { getClubReportYear } from "@/modules/club-reports/repository";
import { clubDirectorRoleLabels, clubRoleDescriptions } from "@/modules/organizations/director-grants-domain";

export const metadata: Metadata = { title: "Club home" };
export const dynamic = "force-dynamic";

/** Where the club stands at a glance, and the next thing to do. */
export default async function ClubHomePage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state === "NO_ROSTER") {
    // A reporter (#375): no roster, no registrations, just monthly reports (#377).
    return (
      <section className="public-manage-card" aria-labelledby="club-role-heading">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Your role: {clubDirectorRoleLabels[access.club.role]}</p>
          <h2 id="club-role-heading">Monthly reports</h2>
        </div>
        <p className="public-manage-empty">
          <FileText size={17} aria-hidden="true" /> {clubRoleDescriptions[access.club.role]}
        </p>
        <Link className="primary-button club-event-action" href={`/account/clubs/${organizationId}/reports`}>
          Open monthly reports <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </section>
    );
  }
  if (access.state !== "OPEN") return null;

  const base = `/account/clubs/${organizationId}`;
  const now = new Date();
  const clubYear = clubYearFor(now);
  const [members, events, reportYear] = await Promise.all([
    listRoster(organizationId, clubYear),
    listClubEvents(organizationId),
    access.capabilities.submitReports ? getClubReportYear(organizationId, clubYear) : Promise.resolve(null),
  ]);
  const active = members.filter((member) => member.status === "ACTIVE");
  const youth = active.filter((member) => member.attendeeType !== "STAFF" && member.attendeeType !== "ADULT");
  const registered = events.filter((event) => event.registration);
  const open = events.filter((event) => !event.registration && event.available && event.phase === "OPEN");

  const steps: Array<{ key: string; text: string; href: string; action: string }> = [];
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
        href: `${base}/reports/${month}`,
        action: "Open report",
      });
    }
  }
  for (const event of open) {
    steps.push({
      key: event.id,
      text: `${event.draft ? "Finish registering" : "Register"} for ${event.name}${event.registrationClosesOn ? ` by ${formatCalendarDate(event.registrationClosesOn)}` : ""}.`,
      href: `${base}/events/${event.id}`,
      action: event.draft ? "Continue" : "Register",
    });
  }

  return (
    <>
      <div className="club-home-stats">
        <Link className="club-home-stat" href={`${base}/roster`}>
          <UsersRound size={20} aria-hidden="true" />
          <strong>{active.length}</strong>
          <span>on the roster{youth.length > 0 ? ` · ${youth.length} youth` : ""}</span>
        </Link>
        <Link className="club-home-stat" href={`${base}/events`}>
          <CalendarDays size={20} aria-hidden="true" />
          <strong>{open.length}</strong>
          <span>{open.length === 1 ? "event open to register" : "events open to register"}</span>
        </Link>
        <Link className="club-home-stat" href={`${base}/events`}>
          <CheckCircle2 size={20} aria-hidden="true" />
          <strong>{registered.length}</strong>
          <span>{registered.length === 1 ? "event registered" : "events registered"}</span>
        </Link>
      </div>

      <section className="public-manage-card" aria-labelledby="club-next-heading">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">What&apos;s next</p>
          <h2 id="club-next-heading">To do</h2>
        </div>
        {steps.length === 0 ? (
          <p className="public-manage-empty"><CheckCircle2 size={17} aria-hidden="true" /> You&apos;re all caught up.</p>
        ) : (
          <ul className="public-manage-club-list">
            {steps.map((step) => (
              <li key={step.key}>
                <CircleAlert size={17} aria-hidden="true" />
                <span><strong>{step.text}</strong></span>
                <Link className="primary-button club-event-action" href={step.href}>
                  {step.action} <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

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
                  <small>{event.registration?.attendeeCount} going · classes and details</small>
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
