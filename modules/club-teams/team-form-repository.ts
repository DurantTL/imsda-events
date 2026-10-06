import { permissionShortLabel } from "@/modules/club-teams/permission-domain";
import "server-only";

import { getPrisma } from "@/lib/prisma";
import { teamLabel } from "@/modules/club-teams/domain";
import { getTeamSettings } from "@/modules/club-teams/settings-repository";
import { ALTERNATE_FIELD_KEY, isAlternateAnswer } from "@/modules/club-teams/rules";
import { buildTeamForm, type TeamFormFilled, type TeamFormModel } from "@/modules/club-teams/team-form";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { currentRegistrationAnswers } from "@/modules/registrations/amendments-repository";

/** The release answer as the paper form shows it: only Yes or No (a checkbox form stores true), else blank. */
function releaseAnswer(value: unknown): "Yes" | "No" | "" {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (typeof value !== "string") return "";
  const answer = value.trim().toLowerCase();
  return answer === "yes" ? "Yes" : answer === "no" ? "No" : "";
}

export type TeamFormPage = { eventName: string; title: string; model: TeamFormModel };

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

async function eventContext(eventId: string, options: { publishedClubOnly?: boolean } = {}) {
  const [event, settings, locations] = await Promise.all([
    getPrisma().event.findUnique({
      where: { id: eventId },
      select: { name: true, startsAt: true, timezone: true, registrationClosesOn: true, isPublished: true, audience: true },
    }),
    getTeamSettings(eventId),
    getPrisma().eventLocation.findMany({
      where: { eventId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
      select: { name: true, address: true },
    }),
  ]);
  // The printed form is for an event that uses teams; any other event has none.
  if (!event || !settings) return null;
  // A director reaches the blank form for a published club event only, never for a draft or another kind of event.
  if (options.publishedClubOnly && (!event.isPublished || event.audience !== "CLUB")) return null;
  return {
    eventName: event.name,
    timezone: event.timezone,
    input: {
      areaDate: calendarDateInEventTimeZone(event.startsAt, event.timezone),
      areaPlaces: locations,
      registrationClosesOn: event.registrationClosesOn,
      settings,
    },
  };
}

/** The blank form for an event (#809): the same wording and dates as the filled one, for a club that mails or emails the paper. */
export async function loadBlankTeamForm(eventId: string, options: { publishedClubOnly?: boolean } = {}): Promise<TeamFormPage | null> {
  const context = await eventContext(eventId, options);
  if (!context) return null;
  return { eventName: context.eventName, title: "Blank team form", model: buildTeamForm({ ...context.input, filled: null }) };
}

type Which = { eventId: string; clubEventRegistrationId: string } | { eventId: string; organizationId: string; teamKey: string };

/**
 * One team's form, filled in from its registration (#809). The caller has decided who may read it: the director route looks
 * the team up under the director's own verified club, the staff route under report access. Birth dates, health answers and
 * every other private answer are never read: the form holds names, the coordinator's contact details and the confirmation.
 */
export async function loadFilledTeamForm(which: Which): Promise<TeamFormPage | null> {
  const context = await eventContext(which.eventId);
  if (!context) return null;
  const row = await getPrisma().clubEventRegistration.findFirst({
    where: "clubEventRegistrationId" in which
      ? { id: which.clubEventRegistrationId, eventId: which.eventId }
      : { eventId: which.eventId, organizationId: which.organizationId, teamKey: which.teamKey },
    select: {
      teamName: true,
      registrationId: true,
      // The director's confirmation is made when the team is registered; its date is the date it was submitted.
      createdAt: true,
      organization: { select: { name: true, parentOrganization: { select: { name: true } } } },
      registration: {
        select: {
          confirmationCode: true,
          status: true,
          location: { select: { name: true } },
          attendees: { orderBy: { position: "asc" }, select: { profileSnapshot: true, formResponses: true, teamPermission: { select: { status: true } } } },
        },
      },
    },
  });
  if (!row || !["SUBMITTED", "CONFIRMED", "WAITLISTED"].includes(row.registration.status)) return null;
  const answers = await currentRegistrationAnswers(which.eventId, row.registrationId);
  const responses = answers?.responses ?? {};

  const members: string[] = [];
  const coaches: string[] = [];
  let alternate = "";
  for (const attendee of row.registration.attendees) {
    const snapshot = (attendee.profileSnapshot ?? {}) as Record<string, unknown>;
    const name = `${text(snapshot.firstName)} ${text(snapshot.lastName)}`.trim();
    if (!name) continue;
    if (snapshot.teamRole === "COACH") { coaches.push(name); continue; }
    // A team member of 18 or older shows where the Area Coordinator's permission stands (#809).
    const shown = attendee.teamPermission ? `${name} (${permissionShortLabel(attendee.teamPermission.status)})` : name;
    const flagged = isAlternateAnswer(((attendee.formResponses ?? {}) as Record<string, unknown>)[ALTERNATE_FIELD_KEY]);
    if (flagged && !alternate) alternate = shown;
    else members.push(shown);
  }
  const filled: TeamFormFilled = {
    teamName: row.teamName ?? "",
    clubName: row.organization.name,
    church: row.organization.parentOrganization?.name ?? null,
    confirmationCode: row.registration.confirmationCode,
    areaLocation: row.registration.location?.name ?? null,
    coordinator: {
      name: text(responses.coordinator_name),
      address: text(responses.coordinator_address),
      city: text(responses.coordinator_city),
      state: text(responses.coordinator_state),
      zip: text(responses.coordinator_zip),
      phone: text(responses.coordinator_phone),
      email: text(responses.coordinator_email),
    },
    partnerClub: text(responses.partner_club),
    members,
    alternate,
    coaches,
    releaseAnswer: releaseAnswer(responses.photo_video_release),
    confirmed: responses.director_confirmation === true,
    confirmedOn: responses.director_confirmation === true ? calendarDateInEventTimeZone(row.createdAt, context.timezone) : null,
  };
  return {
    eventName: context.eventName,
    title: teamLabel(row.organization.name, row.teamName),
    model: buildTeamForm({ ...context.input, filled }),
  };
}
