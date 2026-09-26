import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CalendarDays, CircleDollarSign, ShieldAlert, ShieldCheck, UserRound, UsersRound } from "lucide-react";
import { ClubInviteAccept } from "@/components/club-invite-accept";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { requireAttendeeSecondStep } from "@/modules/attendee-accounts/portal-second-step";
import { getAttendeeMfaStatus } from "@/modules/attendee-accounts/mfa-service";
import { listRegistrationsForVerifiedEmail, type AttendeeRegistrationSummary } from "@/modules/attendee-accounts/registrations-repository";
import { listInvitesForAccount } from "@/modules/club-imports/invites";
import { listDirectedClubs } from "@/modules/organizations/director-access";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false, follow: false, nocache: true },
};

const moneyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function eventDate(startsAt: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone })
    .format(new Date(startsAt));
}

/** Registrations for events that haven't ended yet, soonest first. */
function upcomingOnly(registrations: AttendeeRegistrationSummary[], now = new Date()) {
  return registrations
    .filter((registration) => new Date(registration.event.endsAt) >= now)
    .sort((a, b) => a.event.startsAt.localeCompare(b.event.startsAt));
}

/** The account's front page: where things stand, and a way into each area. */
export default async function AttendeeAccountOverviewPage() {
  await requireAttendeeSecondStep();
  const { account, via } = await getCurrentAttendee();
  if (!account) redirect("/account/sign-in");

  const [registrations, mfaStatus, clubs, invites] = await Promise.all([
    listRegistrationsForVerifiedEmail(account.verifiedEmail),
    getAttendeeMfaStatus(account.id),
    listDirectedClubs(account.id),
    // Only the person themselves may accept, so staff viewing an account don't see them.
    via === "attendee" ? listInvitesForAccount(account.verifiedEmail) : Promise.resolve([]),
  ]);
  const upcoming = upcomingOnly(registrations);
  const next = upcoming[0];
  const balanceDue = registrations.reduce((total, registration) => total + Math.max(registration.balanceCents, 0), 0);
  const authenticatorOn = mfaStatus.status === "ACTIVE";

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Your account</p>
          <h1>Hello, <span translate="no">{account.displayName}</span></h1>
          <p>Signed in as <strong>{account.verifiedEmail}</strong></p>
        </div>
      </section>

      {invites.length > 0 && <ClubInviteAccept invites={invites} />}

      <div className="account-overview-grid">
        <section className="public-manage-card account-overview-card">
          <p className="public-registration-eyebrow"><CalendarDays size={15} aria-hidden="true" /> Registrations</p>
          {next ? (
            <>
              <h2>{next.event.name}</h2>
              <p>{eventDate(next.event.startsAt, next.event.timezone)}{next.event.location ? ` · ${next.event.location}` : ""}</p>
              <p className="field-help">
                {upcoming.length === 1 ? "Your next event." : `Your next of ${upcoming.length} upcoming events.`}
              </p>
            </>
          ) : (
            <>
              <h2>{registrations.length === 0 ? "No registrations yet" : "Nothing coming up"}</h2>
              <p className="field-help">Registrations made with {account.verifiedEmail} show up here.</p>
            </>
          )}
          {balanceDue > 0 && (
            <p className="account-overview-alert">
              <CircleDollarSign size={16} aria-hidden="true" /> <span translate="no">{moneyFormatter.format(balanceDue / 100)}</span> still due
            </p>
          )}
          <Link className="secondary-button account-overview-link" href="/account/registrations">
            View registrations <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </section>

        {clubs.length > 0 && (
          <section className="public-manage-card account-overview-card">
            <p className="public-registration-eyebrow"><UsersRound size={15} aria-hidden="true" /> {clubs.length === 1 ? "My club" : "My clubs"}</p>
            <ul className="account-overview-list">
              {clubs.map((club) => (
                <li key={club.organizationId}>
                  <Link href={`/account/clubs/${club.organizationId}`}>
                    <strong translate="no">{club.name}</strong>
                    <small>{clubDirectorRoleLabels[club.role]}</small>
                    <ArrowRight size={15} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="field-help">Roster, club event registration, and class choices.</p>
          </section>
        )}

        <section className="public-manage-card account-overview-card">
          <p className="public-registration-eyebrow">
            {authenticatorOn ? <ShieldCheck size={15} aria-hidden="true" /> : <ShieldAlert size={15} aria-hidden="true" />} Sign-in &amp; security
          </p>
          <h2>{authenticatorOn ? "Two-step sign-in is on" : "Two-step sign-in is off"}</h2>
          <p className="field-help">
            {authenticatorOn
              ? "Your authenticator protects club rosters and account changes."
              : clubs.length > 0
                ? "Club rosters hold young people's birth dates, so they need an authenticator. Set one up to open your club."
                : "Add an authenticator app for extra protection."}
          </p>
          <Link className={`${!authenticatorOn && clubs.length > 0 ? "primary-button" : "secondary-button"} account-overview-link`} href="/account/security">
            {authenticatorOn ? "Manage sign-in" : "Set up an authenticator"} <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </section>

        <section className="public-manage-card account-overview-card">
          <p className="public-registration-eyebrow"><UserRound size={15} aria-hidden="true" /> Profile</p>
          <h2>Your details</h2>
          <p className="field-help">Saved details fill in new registration forms for you, so you don&apos;t retype them.</p>
          <Link className="secondary-button account-overview-link" href="/account/profile">
            Edit profile <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </section>
      </div>
    </>
  );
}
