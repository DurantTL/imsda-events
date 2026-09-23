import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { ClubAccessGate } from "@/components/club-access-gate";
import { ClubClassPicker } from "@/components/club-class-picker";
import { ClubRegistrationWorkspace } from "@/components/club-registration-workspace";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { attendeeProfilePrefill, getAttendeeProfile } from "@/modules/attendee-accounts/profile-service";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { ClubRegistrationError, getClubEventWorkspace } from "@/modules/club-registrations/repository";
import { getClassSelectionWorkspace } from "@/modules/honors/enrollment-repository";

export const metadata: Metadata = { title: "Club registration" };
export const dynamic = "force-dynamic";

export default async function ClubEventRegistrationPage({
  params,
}: {
  params: Promise<{ organizationId: string; eventId: string }>;
}) {
  const { organizationId, eventId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state === "SIGN_IN") redirect("/account/sign-in");
  if (access.state === "NOT_FOUND") notFound();

  let workspace: Awaited<ReturnType<typeof getClubEventWorkspace>> | null = null;
  if (access.state === "OPEN") {
    try {
      workspace = await getClubEventWorkspace(organizationId, eventId);
    } catch (error) {
      if (error instanceof ClubRegistrationError) notFound();
      throw error;
    }
  }

  const classes = workspace?.registration ? await getClassSelectionWorkspace(organizationId, eventId) : null;

  let contactPrefill: Record<string, string> = {};
  if (workspace?.experience) {
    const { account } = await getCurrentAttendee();
    const prefill = account ? attendeeProfilePrefill(await getAttendeeProfile(account.id), account.verifiedEmail) : {};
    const registrationKeys = new Set(workspace.experience.form.definition.sections
      .flatMap((section) => section.fields)
      .filter((field) => field.scope === "REGISTRATION")
      .map((field) => field.key));
    contactPrefill = Object.fromEntries(Object.entries(prefill).flatMap(([key, value]) => (
      registrationKeys.has(key) && typeof value === "string" && value ? [[key, value]] : []
    )));
  }

  return (
    <main className="public-registration-page public-manage-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/account">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
          <Link className="text-button" href={`/account/clubs/${organizationId}`}>Back to my club</Link>
        </div>
      </header>

      <section className="public-registration-hero public-manage-hero">
        <div>
          <p className="public-registration-eyebrow" translate="no">{access.club.name}</p>
          <h1>{workspace?.event.name ?? "Club registration"}</h1>
          {workspace && <p>Billed to your church. No payment is taken online.</p>}
        </div>
      </section>

      <div className="club-roster-layout">
        <ClubAccessGate access={access} />
        {workspace?.registration && (
          <section className="public-manage-card">
            <div className="public-manage-card-heading">
              <p className="public-registration-eyebrow">Registered</p>
              <h2><CheckCircle2 size={20} aria-hidden="true" /> Your club is registered</h2>
            </div>
            <p>
              Confirmation <strong translate="no">{workspace.registration.confirmationCode}</strong> ·{" "}
              {workspace.registration.attendees.length} going. A confirmation email was sent to the contact on the registration.
            </p>
            <ul className="public-manage-club-list">
              {workspace.registration.attendees.map((attendee, index) => (
                <li key={`${attendee.lastName}-${attendee.firstName}-${index}`}>
                  <span>
                    <strong translate="no">{attendee.lastName}, {attendee.firstName}</strong>
                    {attendee.ageOnEventDate !== null && <small>Age {attendee.ageOnEventDate} at the event</small>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="public-manage-empty">
              Need to add or remove someone? Contact the event team for now. Director edits are coming next.
            </p>
          </section>
        )}
        {classes && <ClubClassPicker eventId={eventId} initialWorkspace={classes} organizationId={organizationId} />}
        {workspace && !workspace.registration && workspace.problem && (
          <section className="public-manage-card">
            <p className="public-manage-empty">{workspace.problem} Let the event team know so they can fix the form.</p>
          </section>
        )}
        {workspace && !workspace.registration && !workspace.problem && workspace.event.phase !== "OPEN" && (
          <section className="public-manage-card">
            <p className="public-manage-empty">
              {workspace.event.phase === "CLOSED"
                ? `Registration closed${workspace.event.registrationClosesOn ? ` after ${workspace.event.registrationClosesOn}` : ""}.`
                : "Registration for this event isn't open yet."}
            </p>
          </section>
        )}
        {workspace && !workspace.registration && !workspace.problem && workspace.event.phase === "OPEN" && workspace.experience && (
          <ClubRegistrationWorkspace
            contactPrefill={contactPrefill}
            organizationId={organizationId}
            workspace={{ ...workspace, experience: workspace.experience }}
          />
        )}
      </div>
    </main>
  );
}
