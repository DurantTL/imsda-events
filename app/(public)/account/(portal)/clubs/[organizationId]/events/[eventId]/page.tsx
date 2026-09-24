import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CalendarDays, CheckCircle2, QrCode } from "lucide-react";
import { ClubClassPicker } from "@/components/club-class-picker";
import { ClubPassQr } from "@/components/club-pass-qr";
import { clubPassIsAvailable } from "@/modules/checkin/club-pass-token";
import { ClubRegistrationEditor } from "@/components/club-registration-editor";
import { ClubRegistrationWorkspace } from "@/components/club-registration-workspace";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { attendeeProfilePrefill, getAttendeeProfile } from "@/modules/attendee-accounts/profile-service";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { loadDirectorClubAssignment } from "@/modules/club-registrations/director-assignment";
import { isChurchBilledStatus, notBilledLabel } from "@/modules/club-registrations/church-owed";
import { ClubRegistrationError, getClubEventWorkspace } from "@/modules/club-registrations/repository";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { getClassSelectionWorkspace } from "@/modules/honors/enrollment-repository";

export const metadata: Metadata = { title: "Club registration" };
export const dynamic = "force-dynamic";

const moneyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
function moneyLabel(cents: number) {
  return moneyFormatter.format(cents / 100);
}

export default async function ClubEventRegistrationPage({
  params,
}: {
  params: Promise<{ organizationId: string; eventId: string }>;
}) {
  const { organizationId, eventId } = await params;
  const access = await getRosterAccessState(organizationId);
  // The club layout shows the sign-in and authenticator steps.
  if (access.state !== "OPEN") return null;

  let workspace: Awaited<ReturnType<typeof getClubEventWorkspace>>;
  try {
    workspace = await getClubEventWorkspace(organizationId, eventId);
  } catch (error) {
    if (error instanceof ClubRegistrationError) notFound();
    throw error;
  }

  const classes = workspace.registration ? await getClassSelectionWorkspace(organizationId, eventId) : null;
  // #410: only shown once staff have set something — an empty section would
  // tell a director less than nothing. The loader re-checks this club's
  // roster access itself rather than trusting the check above.
  const assignment = workspace.registration ? await loadDirectorClubAssignment(organizationId, eventId) : null;

  let contactPrefill: Record<string, string> = {};
  if (workspace.experience) {
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
    <>
      <section className="public-manage-card club-event-heading">
        <Link className="text-button" href={`/account/clubs/${organizationId}/events`}>
          <ArrowLeft aria-hidden="true" size={14} /> All club events
        </Link>
        <h2>{workspace.event.name}</h2>
        <p className="field-help">Billed to your church. No payment is taken online.</p>
      </section>
      {workspace.registration && (
        <section className="public-manage-card">
          <div className="public-manage-card-heading">
            <p className="public-registration-eyebrow">Registered</p>
            <h2><CheckCircle2 size={20} aria-hidden="true" /> Your club is registered</h2>
          </div>
          <p>
            Confirmation <strong translate="no">{workspace.registration.confirmationCode}</strong> ·{" "}
            {workspace.registration.attendees.length} going. A confirmation email was sent to the contact on the registration.
          </p>
          <p className="field-help">
            {isChurchBilledStatus(workspace.registration.status)
              ? (
                <>
                  Estimated amount owed by your church: <strong translate="no">{moneyLabel(workspace.registration.amountOwedCents)}</strong> · billed to the church after the event, not paid online.
                </>
              )
              : notBilledLabel(workspace.registration.status)}
          </p>
          {(activeRegistrationStatuses as readonly string[]).includes(workspace.registration.status)
            && clubPassIsAvailable(new Date(workspace.event.endsAt)) && (
            // Q1 (#412): one QR for the whole club, not one per member.
            // Staff scan it (or the confirmation code) to open this club's
            // check-in view directly; clubs still check in per member there.
            <div className="club-pass-card">
              <ClubPassQr eventId={eventId} organizationId={organizationId} />
              <p className="field-help">
                <QrCode aria-hidden="true" size={15} /> Show this at check-in
                so staff can open your club&rsquo;s list. Confirmation{" "}
                <strong translate="no">{workspace.registration.confirmationCode}</strong> works too.
              </p>
            </div>
          )}
          <ul className="public-manage-club-list">
            {workspace.registration.attendees.map((attendee, index) => (
              <li key={`${attendee.lastName}-${attendee.firstName}-${index}`}>
                <span>
                  <strong translate="no">{attendee.lastName}, {attendee.firstName}</strong>
                  {attendee.ageOnEventDate !== null && <small>Age {attendee.ageOnEventDate} at the event</small>}
                  {attendee.temporary && <small>Not on your roster · this event only</small>}
                </span>
              </li>
            ))}
          </ul>
          {assignment && (
            <div className="public-manage-card club-assignments-block">
              <h3>Your assignments</h3>
              <ul className="public-manage-club-list">
                {assignment.fields.campsiteLocation && (
                  <li>Campsite: <strong translate="no">{assignment.fields.campsiteLocation}</strong>{assignment.fields.campsiteNotes ? ` — ${assignment.fields.campsiteNotes}` : ""}</li>
                )}
                {assignment.fields.dutyLabel && (
                  <li>
                    Duty: <strong translate="no">{assignment.fields.dutyLabel}</strong>
                    {(assignment.fields.dutyDay || assignment.fields.dutyTime) && ` — ${[assignment.fields.dutyDay, assignment.fields.dutyTime].filter(Boolean).join(" ")}`}
                  </li>
                )}
                {assignment.fields.activityLabel && <li>Activity: <strong translate="no">{assignment.fields.activityLabel}</strong></li>}
                {assignment.fields.notes && <li>Notes: {assignment.fields.notes}</li>}
              </ul>
            </div>
          )}
          {workspace.event.edit.open && workspace.experience
            ? (
              <ClubRegistrationEditor
                organizationId={organizationId}
                workspace={{ ...workspace, registration: workspace.registration, experience: workspace.experience }}
              />
            )
            : (
              <p className="public-manage-empty">
                {workspace.event.edit.open ? "Contact the event team to add or remove someone." : workspace.event.edit.message}
              </p>
            )}
        </section>
      )}
      {classes && <ClubClassPicker eventId={eventId} initialWorkspace={classes} organizationId={organizationId} />}
      {classes && classes.offerings.length > 0 && (
        <section className="public-manage-card club-schedule-link">
          <p>
            <CalendarDays size={17} aria-hidden="true" /> See everyone&apos;s classes by session, to print or share with your staff.
          </p>
          <Link className="secondary-button club-event-action" href={`/account/clubs/${organizationId}/events/${eventId}/schedule`}>
            Class schedule <ArrowRight aria-hidden="true" size={14} />
          </Link>
        </section>
      )}
      {!workspace.registration && workspace.problem && (
        <section className="public-manage-card">
          <p className="public-manage-empty">{workspace.problem} Let the event team know so they can fix the form.</p>
        </section>
      )}
      {!workspace.registration && !workspace.problem && workspace.event.phase !== "OPEN" && (
        <section className="public-manage-card">
          <p className="public-manage-empty">
            {workspace.event.phase === "CLOSED"
              ? `Registration closed${workspace.event.registrationClosesOn ? ` after ${workspace.event.registrationClosesOn}` : ""}.`
              : "Registration for this event isn't open yet."}
          </p>
        </section>
      )}
      {!workspace.registration && !workspace.problem && workspace.event.phase === "OPEN" && workspace.experience && (
        <ClubRegistrationWorkspace
          contactPrefill={contactPrefill}
          organizationId={organizationId}
          workspace={{ ...workspace, experience: workspace.experience }}
        />
      )}
    </>
  );
}
