import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight, CalendarDays, CheckCircle2, MapPin, Plus, Printer, QrCode, UsersRound } from "lucide-react";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { BackLink } from "@/components/back-link";
import { NeedsAttention, StatusComplete } from "@/components/needs-attention";
import { classChoiceReadiness, readinessSummaryText } from "@/modules/honors/class-readiness";
import { ClubHonorsNote } from "@/components/club-honors-note";
import { ClubClassPicker } from "@/components/club-class-picker";
import { ClubPassQr } from "@/components/club-pass-qr";
import { clubPassIsAvailable } from "@/modules/checkin/club-pass-token";
import { ClubRegistrationEditor } from "@/components/club-registration-editor";
import { ClubRegistrationWorkspace } from "@/components/club-registration-workspace";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { getAttendeeProfile } from "@/modules/attendee-accounts/profile-service";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { directorContactPrefill } from "@/modules/club-registrations/contact-prefill";
import { loadDirectorClubAssignment } from "@/modules/club-registrations/director-assignment";
import { PerPersonPriceNotice } from "@/components/per-person-price-notice";
import { noCostPrice } from "@/modules/club-registrations/per-person-price";
import { isChurchBilledStatus, notBilledLabel } from "@/modules/club-registrations/church-owed";
import { clubPortalComplianceStatuses } from "@/modules/background-checks/repository";
import { ClubRegistrationError, getClubEventWorkspace } from "@/modules/club-registrations/repository";
import { activeRegistrationStatuses, registrationClosedMessage } from "@/modules/events/lifecycle";
import { getClassSelectionWorkspaceIfRegistered, getRegistrationHonorsCatalog } from "@/modules/honors/enrollment-repository";
import { TEAM_LEVELS, teamLevelLabels, draftKeySchema, singleSearchParam } from "@/modules/club-teams/domain";

export const metadata: Metadata = { title: "Club registration" };
export const dynamic = "force-dynamic";

export default async function ClubEventRegistrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; eventId: string }>;
  searchParams: Promise<{ team?: string | string[]; draft?: string | string[] }>;
}) {
  const { organizationId, eventId } = await params;
  const { team: rawTeam, draft: rawDraft } = await searchParams;
  // A repeated ?team= or ?draft= names nothing.
  const requestedTeam = singleSearchParam(rawTeam);
  const requestedDraft = singleSearchParam(rawDraft);
  if (requestedTeam === null || requestedDraft === null) notFound();
  const access = await getRosterAccessStateForPage(organizationId);
  // The club layout shows the sign-in and authenticator steps.
  if (access.state !== "OPEN") return null;

  // A club that registers several teams (#809) has a page for each team and one for each team being started; the
  // address says which. An event without teams ignores both and shows the one registration it has always had.
  const requestedDraftKey = draftKeySchema.safeParse(requestedDraft).success ? requestedDraft : null;
  let workspace: Awaited<ReturnType<typeof getClubEventWorkspace>>;
  try {
    workspace = await getClubEventWorkspace(organizationId, eventId, new Date(), { teamKey: requestedTeam || null, draftKey: requestedDraftKey });
  } catch (error) {
    if (error instanceof ClubRegistrationError) notFound();
    throw error;
  }
  const multipleTeams = workspace.teams.multiple;
  // A team this club never registered (another club's, a stale link, a made-up key), or one on an event without teams, is not found.
  if (requestedTeam && (!multipleTeams || !workspace.registration)) notFound();
  const eventBase = `/account/clubs/${organizationId}/events/${eventId}`;
  const canStartTeam = !workspace.problem && workspace.event.phase === "OPEN" && Boolean(workspace.experience);
  // The first team goes straight to its form: there is nothing to choose between yet.
  if (multipleTeams && !workspace.registration && !requestedDraftKey && canStartTeam
    && workspace.teams.registered.length === 0 && workspace.teams.drafts.length === 0) {
    redirect(`${eventBase}?draft=${crypto.randomUUID().replaceAll("-", "")}`);
  }
  // Whether the page is showing one team (registered, or being started) rather than the list of the club's teams.
  const showingTeam = !multipleTeams || Boolean(workspace.registration) || requestedDraftKey !== null;
  const teamQuery = workspace.registration?.teamKey ? `?team=${encodeURIComponent(workspace.registration.teamKey)}` : "";

  // A waitlisted or cancelled registration holds no seats, so it has no class picker. An event with several teams per club has no classes.
  const classes = workspace.registration && !multipleTeams ? await getClassSelectionWorkspaceIfRegistered(organizationId, eventId) : null;
  // Classes chosen while registering (#618); once registered, the class picker below takes over.
  const honorsCatalog = !workspace.registration && !multipleTeams && workspace.experience ? await getRegistrationHonorsCatalog(
    organizationId,
    eventId,
    // Known without asking the browser: no locations, or exactly one.
    workspace.locations.length === 0 ? null : workspace.locations.length === 1 ? workspace.locations[0]!.id : undefined,
  ) : null;
  // A registered club is not "complete" until every person has a class for each session they can take (#799 G3).
  const classReadiness = classes && classes.open && !classes.locationRequired && classes.offerings.length > 0
    ? classChoiceReadiness({ attendees: classes.attendees, sessions: classes.sessions, offerings: classes.offerings, selections: classes.selections, saved: classes.selections })
    : null;
  // #410: only shown once staff have set something — an empty section would
  // tell a director less than nothing. The loader re-checks this club's
  // roster access itself rather than trusting the check above.
  const assignment = workspace.registration ? await loadDirectorClubAssignment(organizationId, eventId, workspace.registration.teamKey) : null;

  // A free team event (#809) has no church bill to announce.
  const freeTeamEvent = workspace.event.noCost;

  let contactPrefill: Record<string, string> = {};
  // Never prefill from an attendee account while staff act as director
  // (#442): the accounts stay separate, and any attendee cookie on this
  // browser isn't the club's contact.
  if (workspace.experience && access.actor.kind === "ATTENDEE") {
    const { account } = await getCurrentAttendee();
    if (account) {
      const profile = await getAttendeeProfile(account.id);
      // One key/type-to-source table for every club form (#618); the director's
      // name, email and mobile phone only.
      contactPrefill = directorContactPrefill(workspace.experience.form.definition, {
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: account.verifiedEmail,
        mobile: profile.phone,
      });
    }
  }
  // The club and church directory fields (#482): always this club's own
  // record, whether an attendee director or staff acting as director is
  // registering — never a personal preference, so it applies either way.
  contactPrefill = { ...contactPrefill, ...workspace.directory.prefillResponses };

  // Staff and adults without a current background check say so on their card (#853): only for a director or deputy,
  // the same people who see these statuses on the roster, and only status, never a note.
  const showingNewForm = showingTeam && !workspace.registration && !workspace.problem && workspace.event.phase === "OPEN" && Boolean(workspace.experience);
  const complianceStatuses = showingNewForm
    ? await clubPortalComplianceStatuses(organizationId, clubYearFor(new Date(workspace.event.startsAt)), access.capabilities)
    : undefined;
  const backgroundStates = complianceStatuses
    ? Object.fromEntries(Object.entries(complianceStatuses).map(([memberId, status]) => [memberId, status.state]))
    : undefined;

  return (
    <>
      <section className="public-manage-card club-event-heading">
        <BackLink href={multipleTeams && showingTeam ? eventBase : `/account/clubs/${organizationId}/events`}>
          {multipleTeams && showingTeam ? "Back to your teams" : "Back to club events"}
        </BackLink>
        <h2>{workspace.event.name}{workspace.registration?.teamName ? <> · <span translate="no">{workspace.registration.teamName}</span></> : ""}</h2>
        <p className="field-help">{freeTeamEvent ? "No cost. No payment is taken online." : "Billed to your church. No payment is taken online."}</p>
      </section>
      {multipleTeams && !showingTeam && (
        <section className="public-manage-card" aria-labelledby="club-teams-heading">
          <div className="public-manage-card-heading">
            <p className="public-registration-eyebrow">Your teams</p>
            <h2 id="club-teams-heading"><UsersRound size={20} aria-hidden="true" /> Teams registered for this event</h2>
          </div>
          <p className="field-help">
            Your club can enter more than one team. Each team has its own name, its own people, and its own registration.
          </p>
          {workspace.teams.registered.length === 0 && workspace.teams.drafts.length === 0 && (
            <p className="public-manage-empty">Your club has not registered a team yet.</p>
          )}
          <ul className="public-manage-club-list">
            {workspace.teams.registered.map((team) => (
              <li key={team.teamKey}>
                <CheckCircle2 size={17} aria-hidden="true" />
                <span>
                  <strong translate="no">{team.teamName}</strong>
                  <small>
                    Confirmation <span translate="no">{team.confirmationCode}</span> · {team.attendeeCount} {team.attendeeCount === 1 ? "person" : "people"}
                    {team.locationName ? <> · <span translate="no">{team.locationName}</span></> : ""}
                    {team.status === "WAITLISTED" ? " · On the waitlist" : team.status === "CANCELLED" ? " · Cancelled" : ""}
                  </small>
                </span>
                <Link className="secondary-button club-event-action" href={`${eventBase}?team=${encodeURIComponent(team.teamKey)}`}>
                  View <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </li>
            ))}
            {workspace.teams.drafts.map((entry) => (
              <li key={entry.draftKey}>
                <CalendarDays size={17} aria-hidden="true" />
                <span>
                  <strong translate="no">{entry.teamName || "Unnamed team"}</strong>
                  <small>Not submitted yet · {entry.selectedCount} chosen</small>
                </span>
                <Link className="secondary-button club-event-action" href={`${eventBase}?draft=${encodeURIComponent(entry.draftKey)}`}>
                  Continue <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
          {workspace.teams.settings && (
            <p><Link className="text-button" href={`${eventBase}/team-form/blank`}>Blank team form to mail or email</Link></p>
          )}
          {canStartTeam ? (
            <Link className="primary-button club-event-action" href={`${eventBase}?draft=${crypto.randomUUID().replaceAll("-", "")}`}>
              <Plus size={14} aria-hidden="true" /> Register {workspace.teams.registered.length > 0 ? "another" : "a"} team
            </Link>
          ) : workspace.problem ? (
            <p className="public-manage-empty">{workspace.problem} Let the event team know so they can fix the form.</p>
          ) : (
            <p className="public-manage-empty">
              {workspace.event.phase === "CLOSED" ? "Registration has closed, so no more teams can be added." : "Registration isn't open yet."}
            </p>
          )}
        </section>
      )}
      {workspace.registration && (
        <section className="public-manage-card">
          <div className="public-manage-card-heading">
            <p className="public-registration-eyebrow">Registered</p>
            <h2><CheckCircle2 size={20} aria-hidden="true" /> {workspace.registration.teamName ? <><span translate="no">{workspace.registration.teamName}</span> is registered</> : "Your club is registered"}</h2>
          </div>
          <ClubHonorsNote eventId={eventId} organizationId={organizationId} />
          {classReadiness && (
            <p className="class-readiness-summary" role="status">
              {classReadiness.complete
                ? <StatusComplete label={readinessSummaryText(classReadiness)} />
                : <><NeedsAttention label={readinessSummaryText(classReadiness)} /> Choose them under Classes below.</>}
            </p>
          )}
          <p>
            Confirmation <strong translate="no">{workspace.registration.confirmationCode}</strong> ·{" "}
            {workspace.registration.attendees.length} going. {workspace.registration.confirmationEmail.registrationSaved}
          </p>
          <p
            className="field-help"
            data-email-status={workspace.registration.confirmationEmail.status}
            role="status"
          >
            {workspace.registration.confirmationEmail.email}
            {workspace.registration.confirmationEmail.supportEmail && (
              <>
                {" "}Questions? Email{" "}
                <a href={`mailto:${workspace.registration.confirmationEmail.supportEmail}`}>
                  {workspace.registration.confirmationEmail.supportEmail}
                </a>.
              </>
            )}
          </p>
          {workspace.registration.location && (
            <p>
              <MapPin aria-hidden="true" size={15} /> Location: <strong translate="no">{workspace.registration.location.name}</strong>
              {workspace.registration.location.address ? <> · <span translate="no">{workspace.registration.location.address}</span></> : ""}
              {" · "}{formatCalendarDate(workspace.registration.location.firstDay)}
              {workspace.registration.location.lastDay !== workspace.registration.location.firstDay ? <> to {formatCalendarDate(workspace.registration.location.lastDay)}</> : ""}
            </p>
          )}
          {workspace.registration.permissionNotices.length > 0 && (
            <ul className={`inline-notice team-permission-notices${workspace.registration.permissionNotices.some((notice) => notice.status !== "GRANTED") ? " warning" : ""}`} role="status">
              {workspace.registration.permissionNotices.map((notice) => <li key={notice.attendeeId} translate="no">{notice.text}</li>)}
            </ul>
          )}
          <div className="field-help">
            {isChurchBilledStatus(workspace.registration.status)
              ? <PerPersonPriceNotice price={freeTeamEvent ? noCostPrice(workspace.registration.perPerson) : workspace.registration.perPerson} />
              : notBilledLabel(workspace.registration.status)}
          </div>
          {(activeRegistrationStatuses as readonly string[]).includes(workspace.registration.status)
            && clubPassIsAvailable(new Date(workspace.event.endsAt)) && (
            // Q1 (#412): one QR for the whole club, not one per member.
            // Staff scan it (or the confirmation code) to open this club's
            // check-in view directly; clubs still check in per member there.
            <div className="club-pass-card">
              <ClubPassQr eventId={eventId} organizationId={organizationId} teamKey={workspace.registration.teamKey} />
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
                  {attendee.teamRole === "COACH" && <small>Coach</small>}
                  {attendee.alternate && <small>Alternate</small>}
                </span>
              </li>
            ))}
          </ul>
          {(activeRegistrationStatuses as readonly string[]).includes(workspace.registration.status) && (
            <Link className="secondary-button club-event-action" href={`/account/clubs/${organizationId}/events/${eventId}/packet${teamQuery}`}>
              <Printer aria-hidden="true" size={14} /> Print club packet
            </Link>
          )}
          {workspace.teams.settings && (
            <p>
              <Link className="secondary-button club-event-action" href={`${eventBase}/team-form${teamQuery}`}>
                <Printer aria-hidden="true" size={14} /> Print team form
              </Link>{" "}
              <Link className="text-button" href={`${eventBase}/team-form/blank`}>Blank form to mail or email</Link>
            </p>
          )}
          {workspace.registration.results.length > 0 && (
            <div className="public-manage-card team-results-block" aria-labelledby="team-results-heading">
              <h3 id="team-results-heading">Results</h3>
              <ul className="public-manage-club-list">
                {TEAM_LEVELS.flatMap((level) => {
                  const result = workspace.registration!.results.find((entry) => entry.level === level);
                  return result ? [(
                    <li key={level}>
                      <span>
                        <strong>{teamLevelLabels[level]}</strong>
                        <small>
                          {result.placement || "No placement entered"} · {result.qualified ? "Qualified for the next level" : "Did not qualify for the next level"}
                          {result.notes ? ` · ${result.notes}` : ""}
                        </small>
                      </span>
                    </li>
                  )] : [];
                })}
              </ul>
            </div>
          )}
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
      {showingTeam && !workspace.registration && workspace.problem && (
        <section className="public-manage-card">
          <p className="public-manage-empty">{workspace.problem} Let the event team know so they can fix the form.</p>
        </section>
      )}
      {showingTeam && !workspace.registration && !workspace.problem && workspace.event.phase !== "OPEN" && (
        <section className="public-manage-card">
          <p className="public-manage-empty">
            {workspace.locations.length > 0
              ? workspace.event.phase === "CLOSED"
                ? "Registration has closed at every location."
                : "Registration isn't open yet at any location."
              : workspace.event.phase === "CLOSED" && workspace.event.ended
              ? registrationClosedMessage
              : workspace.event.phase === "CLOSED"
              ? `Registration closed${workspace.event.registrationClosesOn ? ` after ${workspace.event.registrationClosesOn}` : ""}.`
              : "Registration for this event isn't open yet."}
          </p>
        </section>
      )}
      {showingTeam && !workspace.registration && !workspace.problem && workspace.event.phase === "OPEN" && workspace.experience && (
        <ClubRegistrationWorkspace
          contactPrefill={contactPrefill}
          draftKey={multipleTeams ? requestedDraftKey ?? "" : ""}
          backgroundStates={backgroundStates}
          honorsCatalog={honorsCatalog && honorsCatalog.offerings.length > 0 ? honorsCatalog : null}
          organizationId={organizationId}
          workspace={{ ...workspace, experience: workspace.experience }}
        />
      )}
    </>
  );
}
