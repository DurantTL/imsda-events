import "server-only";

import type { Prisma } from "@prisma/client";
import { ClubTeamError } from "@/modules/club-teams/errors";
import { normalizeTeamName } from "@/modules/club-teams/domain";
import { ALTERNATE_FIELD_KEY, isAlternateAnswer, teamRoleFor, teamRuleProblems, type TeamPerson } from "@/modules/club-teams/rules";
import { getTeamSettings } from "@/modules/club-teams/settings-repository";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { isAgeFieldKey } from "@/modules/forms/definition";

type Tx = Prisma.TransactionClient;

const ACTIVE_STATUSES = ["SUBMITTED", "CONFIRMED", "WAITLISTED"] as const;

/** The sentence for a person who is already on another team of the club (#809), the same wherever it is raised. */
export const onOtherTeamMessage = (name: string) =>
  `${name || "Someone"} is already on another team from your club for this event. Everyone is on one team only: remove them here, or from the other team.`;

const personKey = (name: string) => normalizeTeamName(name);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The people (team members, the alternate, coaches, extra people) who are already on another team of the same club for
 * this event, as their names. A roster person is matched by the person record; an extra person, or anyone added who is
 * not on the club's roster, by their normalized first and last name against everyone on the club's other active
 * registrations. Run inside the
 * caller's Serializable transaction so two saves that share a person cannot both land.
 */
export async function peopleOnOtherTeams(
  client: Pick<Tx, "registrationAttendee">,
  input: {
    eventId: string;
    organizationId: string;
    people: ReadonlyArray<{ personId: string; name: string }>;
    guestNames: readonly string[];
    excludeRegistrationId?: string;
  },
): Promise<string[]> {
  const registrationWhere = {
    status: { in: [...ACTIVE_STATUSES] },
    clubRegistration: {
      is: { organizationId: input.organizationId, ...(input.excludeRegistrationId ? { registrationId: { not: input.excludeRegistrationId } } : {}) },
    },
  };
  const found: string[] = [];
  if (input.people.length > 0) {
    const rows = await client.registrationAttendee.findMany({
      where: { eventId: input.eventId, personId: { in: input.people.map((person) => person.personId) }, registration: registrationWhere },
      select: { personId: true },
    });
    const taken = new Set(rows.map((row) => row.personId));
    found.push(...input.people.filter((person) => taken.has(person.personId)).map((person) => person.name));
  }
  if (input.guestNames.length > 0) {
    const rows = await client.registrationAttendee.findMany({
      where: { eventId: input.eventId, registration: registrationWhere },
      select: { profileSnapshot: true },
    });
    const takenNames = new Set(rows.map((row) => {
      const snapshot = record(row.profileSnapshot);
      return personKey(`${typeof snapshot.firstName === "string" ? snapshot.firstName : ""} ${typeof snapshot.lastName === "string" ? snapshot.lastName : ""}`);
    }));
    found.push(...input.guestNames.filter((name) => takenNames.has(personKey(name))));
  }
  return found;
}

export function throwIfOnOtherTeams(names: readonly string[]) {
  if (names.length === 0) return;
  const messages = names.map(onOtherTeamMessage);
  throw new ClubTeamError("TEAM_RULES", messages.join(" "), messages);
}

/**
 * Keeps a team registration inside its event's team rules (#809) however it is changed: the director's edit and a staff
 * amendment both end here, inside the amendment's own Serializable transaction after the attendees are written. It
 * re-reads the settings, works out each person's role from what is stored (the form answers, the age on the age date, the
 * roster), saves a changed role on the person, and refuses the change (so nothing is saved) when the size, alternate,
 * age or one-team rule breaks. A registration that is not a team's is left alone.
 */
export async function enforceTeamRegistrationRules(tx: Tx, registrationId: string): Promise<void> {
  const team = await tx.clubEventRegistration.findUnique({
    where: { registrationId },
    select: { eventId: true, organizationId: true, teamKey: true, registration: { select: { event: { select: { startsAt: true, timezone: true } } } } },
  });
  if (!team || team.teamKey === "") return;
  const settings = await getTeamSettings(team.eventId, tx);
  if (!settings) return;

  const attendees = await tx.registrationAttendee.findMany({
    where: { registrationId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, personId: true, profileSnapshot: true, formResponses: true },
  });
  const roster = await tx.clubRosterMember.findMany({
    where: { organizationId: team.organizationId, status: "ACTIVE", personId: { in: attendees.map((attendee) => attendee.personId) } },
    orderBy: { clubYear: "desc" },
    select: { personId: true, attendeeType: true, classLevel: true },
  });
  const rosterByPerson = new Map<string, (typeof roster)[number]>();
  for (const member of roster) if (member.personId && !rosterByPerson.has(member.personId)) rosterByPerson.set(member.personId, member);

  const eventDate = calendarDateInEventTimeZone(team.registration.event.startsAt, team.registration.event.timezone);
  const people: TeamPerson[] = [];
  const named: Array<{ personId: string; name: string }> = [];
  const guestNames: string[] = [];
  for (const attendee of attendees) {
    const snapshot = record(attendee.profileSnapshot);
    const responses = record(attendee.formResponses);
    const name = `${typeof snapshot.firstName === "string" ? snapshot.firstName : ""} ${typeof snapshot.lastName === "string" ? snapshot.lastName : ""}`.trim();
    // The age on the age date the director's edit stored; a person staff added has only the age answered on the form.
    const answeredAge = Object.entries(responses).find(([key, value]) => isAgeFieldKey(key) && typeof value !== "boolean" && value !== "" && Number.isInteger(Number(value)));
    const age = typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : answeredAge ? Number(answeredAge[1]) : null;
    const rosterMember = rosterByPerson.get(attendee.personId);
    const role = teamRoleFor({
      responses,
      rosterAttendeeType: rosterMember?.attendeeType ?? null,
      rosterClassLevel: rosterMember?.classLevel ?? null,
      maxMemberAge: settings.maxMemberAge,
      age,
    });
    if (snapshot.teamRole !== role || (snapshot.ageOnEventDate ?? null) !== age) {
      await tx.registrationAttendee.update({
        where: { id: attendee.id },
        data: { profileSnapshot: { ...snapshot, teamRole: role, ageOnEventDate: age } as Prisma.InputJsonValue },
      });
    }
    people.push({ name, role, alternate: isAlternateAnswer(responses[ALTERNATE_FIELD_KEY]), age });
    // Someone on the club roster is matched by person; anyone else (an extra person, or one staff typed in) by name.
    if (snapshot.temporary === true || !rosterByPerson.has(attendee.personId)) guestNames.push(name);
    else named.push({ personId: attendee.personId, name });
  }

  const problems = teamRuleProblems(settings, people, eventDate);
  if (problems.length > 0) throw new ClubTeamError("TEAM_RULES", problems.join(" "), problems);
  if (settings.allowMultipleTeams) {
    throwIfOnOtherTeams(await peopleOnOtherTeams(tx, {
      eventId: team.eventId,
      organizationId: team.organizationId,
      people: named,
      guestNames,
      excludeRegistrationId: registrationId,
    }));
  }
}
