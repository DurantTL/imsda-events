import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CalendarDays, CheckCircle2, CircleAlert, FileText, UsersRound } from "lucide-react";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { listClubEvents } from "@/modules/club-registrations/repository";
import { clubDirectorRoleLabels, clubRoleDescriptions } from "@/modules/organizations/director-grants-domain";

export const metadata: Metadata = { title: "Club home" };
export const dynamic = "force-dynamic";

/** Where the club stands at a glance, and the next thing to do. */
export default async function ClubHomePage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state === "NO_ROSTER") {
    // A reporter (#375): no roster, no registrations. Monthly reports arrive with C5.
    return (
      <section className="public-manage-card" aria-labelledby="club-role-heading">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Your role: {clubDirectorRoleLabels[access.club.role]}</p>
          <h2 id="club-role-heading">Monthly reports</h2>
        </div>
        <p className="public-manage-empty">
          <FileText size={17} aria-hidden="true" /> {clubRoleDescriptions[access.club.role]} Monthly report forms will
          appear here once the conference opens them.
        </p>
      </section>
    );
  }
  if (access.state !== "OPEN") return null;

  const base = `/account/clubs/${organizationId}`;
  const [members, events] = await Promise.all([
    listRoster(organizationId, clubYearFor(new Date())),
    listClubEvents(organizationId),
  ]);
  const active = members.filter((member) => member.status === "ACTIVE");
  const youth = active.filter((member) => member.attendeeType !== "STAFF" && member.attendeeType !== "ADULT");
  const registered = events.filter((event) => event.registration);
  const open = events.filter((event) => !event.registration && event.available && event.phase === "OPEN");

  const steps: Array<{ key: string; text: string; href: string; action: string }> = [];
  if (active.length === 0) {
    steps.push({ key: "roster", text: "Add your club members to this year's roster.", href: `${base}/roster`, action: "Add people" });
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
