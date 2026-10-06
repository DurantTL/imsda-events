import "server-only";

import type { Prisma } from "@prisma/client";
import { ClubTeamError } from "@/modules/club-teams/errors";
import { normalizeTeamName } from "@/modules/club-teams/domain";
import { ALTERNATE_FIELD_KEY, ROLE_FIELD_KEY, isAlternateAnswer, teamAgeDate, teamRoleFor, teamRuleProblems, type TeamPerson } from "@/modules/club-teams/rules";
import { syncTeamMemberPermissions } from "@/modules/club-teams/permission-repository";
import { permissionDeclinedGenericProblem, permissionDeclinedProblem } from "@/modules/club-teams/permission-domain";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { openBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn } from "@/modules/club-rosters/domain";
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

/** Someone on another team of the club: found by their person record, or only by a name that matches. */
export type TeamConflict = { name: string; kind: "PERSON" | "NAME" };

const nameOnOtherTeamMessage = (name: string) =>
  `Someone named ${name || "this person"} is already on another team from your club. If this is a different person, contact the event team.`;

/**
 * The people (team members, the alternate, coaches, extra people) who are already on another team of the same club for
 * this event. A person is matched by their person record first. Beyond that, by normalized first and last name: an extra
 * person (or anyone not on the club roster) against everyone on the club's other active registrations, and a roster
 * person against the extra people there, so the check is the same whichever team was saved first. A name-only match
 * can be confirmed as a different person by staff (`skipNameMatch`); those are returned as `confirmed` so they can be
 * audited. A person-record match can never be skipped. Run inside the caller's Serializable transaction so two saves
 * that share a person cannot both land.
 */
export async function peopleOnOtherTeams(
  client: Pick<Tx, "registrationAttendee">,
  input: {
    eventId: string;
    organizationId: string;
    people: ReadonlyArray<{ personId: string | null; name: string; onRoster: boolean; skipNameMatch?: boolean; confirmedNow?: boolean }>;
    excludeRegistrationId?: string;
  },
): Promise<{ conflicts: TeamConflict[]; confirmed: string[] }> {
  if (input.people.length === 0) return { conflicts: [], confirmed: [] };
  const rows = await client.registrationAttendee.findMany({
    where: {
      eventId: input.eventId,
      registration: {
        status: { in: [...ACTIVE_STATUSES] },
        clubRegistration: {
          is: { organizationId: input.organizationId, ...(input.excludeRegistrationId ? { registrationId: { not: input.excludeRegistrationId } } : {}) },
        },
      },
    },
    select: { personId: true, profileSnapshot: true },
  });
  const personIds = new Set(rows.map((row) => row.personId));
  const others = rows.map((row) => {
    const snapshot = record(row.profileSnapshot);
    return {
      key: personKey(`${typeof snapshot.firstName === "string" ? snapshot.firstName : ""} ${typeof snapshot.lastName === "string" ? snapshot.lastName : ""}`),
      extra: snapshot.temporary === true,
    };
  });
  const conflicts: TeamConflict[] = [];
  const confirmed: string[] = [];
  for (const person of input.people) {
    if (person.personId && personIds.has(person.personId)) {
      conflicts.push({ name: person.name, kind: "PERSON" });
      continue;
    }
    const key = personKey(person.name);
    if (!key || !others.some((other) => other.key === key && (!person.onRoster || other.extra))) continue;
    // Only a confirmation made in this save is reported for the audit; a kept one was audited when staff made it.
    if (person.skipNameMatch) {
      if (person.confirmedNow) confirmed.push(person.name);
    } else conflicts.push({ name: person.name, kind: "NAME" });
  }
  return { conflicts, confirmed };
}

export function throwIfOnOtherTeams(conflicts: readonly TeamConflict[]) {
  if (conflicts.length === 0) return;
  const messages = conflicts.map((conflict) => (conflict.kind === "PERSON" ? onOtherTeamMessage(conflict.name) : nameOnOtherTeamMessage(conflict.name)));
  throw new ClubTeamError("TEAM_RULES", messages.join(" "), messages);
}

/**
 * Keeps a team registration inside its event's team rules (#809) however it is changed: the director's edit and a staff
 * amendment both end here, inside the amendment's own Serializable transaction after the attendees are written. It
 * re-reads the settings, works out each person's role from what is stored (the form answers, the age on the age date, the
 * roster), saves a changed role on the person, and refuses the change (so nothing is saved) when the size, alternate,
 * age or one-team rule breaks. A registration that is not a team's is left alone.
 */
export async function enforceTeamRegistrationRules(
  tx: Tx,
  registrationId: string,
  options: {
    /** Staff only: who confirmed, and the attendees confirmed as a different person from a name match (never a person-record match). */
    actorUserId?: string;
    differentPersonAttendeeIds?: ReadonlySet<string>;
    /** Who acted, for the audit rows: an attendee account (a club director) when it was not a staff user. */
    actorAccountId?: string;
    /**
     * Whose declined permission stops this save. "ANY" (the default, a director or staff changing the team): any declined team
     * member. "CHANGED_ONLY" (an attendee's own edit, or a transfer of one person): only a declined person whose own row is
     * being changed here, with a message that names nobody, so a teammate's decline never blocks someone else's edit.
     */
    declineScope?: "ANY" | "CHANGED_ONLY";
    changedAttendeeIds?: ReadonlySet<string>;
  } = {},
): Promise<{ queuedMessageIds: string[] }> {
  const team = await tx.clubEventRegistration.findUnique({
    where: { registrationId },
    select: { id: true, eventId: true, organizationId: true, registration: { select: { event: { select: { startsAt: true, timezone: true } } } } },
  });
  const nothing = { queuedMessageIds: [] as string[] };
  if (!team) return nothing;
  // An event without team rules is not a team event; one with rules but one registration per club is checked too.
  const settings = await getTeamSettings(team.eventId, tx);
  if (!settings) return nothing;

  const attendees = await tx.registrationAttendee.findMany({
    where: { registrationId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, personId: true, profileSnapshot: true, formResponses: true },
  });
  const roster = await tx.clubRosterMember.findMany({
    where: { organizationId: team.organizationId, status: "ACTIVE", personId: { in: attendees.map((attendee) => attendee.personId) } },
    orderBy: { clubYear: "desc" },
    select: { personId: true, attendeeType: true, classLevel: true, sealedBirthDate: true },
  });
  const rosterByPerson = new Map<string, (typeof roster)[number]>();
  for (const member of roster) if (member.personId && !rosterByPerson.has(member.personId)) rosterByPerson.set(member.personId, member);

  const eventDate = calendarDateInEventTimeZone(team.registration.event.startsAt, team.registration.event.timezone);
  const ageDate = teamAgeDate(settings, eventDate);
  const people: TeamPerson[] = [];
  const flagCandidates: Array<{ attendeeId: string; personId: string; name: string; age: number | null; role: "MEMBER" | "COACH"; tlt: boolean }> = [];
  const checked: Array<{ personId: string; name: string; onRoster: boolean; skipNameMatch: boolean; confirmedNow: boolean }> = [];
  for (const attendee of attendees) {
    const snapshot = record(attendee.profileSnapshot);
    const responses = record(attendee.formResponses);
    const name = `${typeof snapshot.firstName === "string" ? snapshot.firstName : ""} ${typeof snapshot.lastName === "string" ? snapshot.lastName : ""}`.trim();
    const rosterMember = rosterByPerson.get(attendee.personId);
    // A birth date on the roster gives the age on the age date. Otherwise the age stored by the director's edit; the form's
    // age answer is only the fallback, for a person staff typed in.
    const answeredAge = Object.entries(responses).find(([key, value]) => isAgeFieldKey(key) && typeof value !== "boolean" && value !== "" && Number.isInteger(Number(value)));
    const age = rosterMember?.sealedBirthDate
      ? ageOn(openBirthDate(rosterMember.sealedBirthDate), ageDate)
      : typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : answeredAge ? Number(answeredAge[1]) : null;
    const role = teamRoleFor({
      responses,
      rosterAttendeeType: rosterMember?.attendeeType ?? null,
      rosterClassLevel: rosterMember?.classLevel ?? null,
      maxMemberAge: settings.maxMemberAge,
      age,
    });
    // Staff's confirmation that this is a different person from someone with the same name on another team is kept on the
    // attendee, so a later save of the team (by anyone) does not refuse them again.
    // The confirmation records who was confirmed (person and normalized name), so it lapses as soon as the attendee row is
    // renamed or pointed at another person; it can never carry over to someone else.
    const confirmation = { personId: attendee.personId, nameKey: personKey(name) };
    const stored = snapshot.differentPersonConfirmed as { personId?: unknown; nameKey?: unknown } | true | undefined;
    const stillConfirmed = typeof stored === "object" && stored !== null && stored.personId === confirmation.personId && stored.nameKey === confirmation.nameKey;
    const staffConfirmsNow = !stillConfirmed && options.actorUserId !== undefined && options.differentPersonAttendeeIds?.has(attendee.id) === true;
    const dropConfirmation = stored !== undefined && !stillConfirmed && !staffConfirmsNow;
    if (snapshot.teamRole !== role || (snapshot.ageOnEventDate ?? null) !== age || staffConfirmsNow || dropConfirmation) {
      const { differentPersonConfirmed: _previous, ...rest } = snapshot;
      void _previous;
      await tx.registrationAttendee.update({
        where: { id: attendee.id },
        data: { profileSnapshot: { ...rest, teamRole: role, ageOnEventDate: age, ...(staffConfirmsNow ? { differentPersonConfirmed: confirmation } : stillConfirmed ? { differentPersonConfirmed: stored } : {}) } as Prisma.InputJsonValue },
      });
    }
    const answeredRole = typeof responses[ROLE_FIELD_KEY] === "string" ? (responses[ROLE_FIELD_KEY] as string).trim().toLowerCase() : "";
    flagCandidates.push({ attendeeId: attendee.id, personId: attendee.personId, name, age, role, tlt: rosterMember?.classLevel === "TLT" || answeredRole === "tlt" });
    people.push({ name, role, alternate: isAlternateAnswer(responses[ALTERNATE_FIELD_KEY]), age });
    // Someone on the club roster is matched by person; anyone else (an extra person, or one staff typed in) by name.
    checked.push({
      personId: attendee.personId,
      name,
      onRoster: snapshot.temporary !== true && rosterByPerson.has(attendee.personId),
      // Staff's confirmation of a different person lasts (it is kept on the attendee), so a later edit by anyone does not ask again.
      skipNameMatch: stillConfirmed || staffConfirmsNow,
      confirmedNow: staffConfirmsNow,

    });
  }

  // Everything wrong is said at once: the size, alternate and age rules, and (where a club can have several teams) anyone who
  // is on another team of the club, so a change is fixed in one go.
  const problems = teamRuleProblems(settings, people, eventDate);
  let confirmedNames: string[] = [];
  if (settings.allowMultipleTeams) {
    const { conflicts, confirmed } = await peopleOnOtherTeams(tx, {
      eventId: team.eventId,
      organizationId: team.organizationId,
      people: checked,
      excludeRegistrationId: registrationId,
    });
    problems.push(...conflicts.map((conflict) => (conflict.kind === "PERSON" ? onOtherTeamMessage(conflict.name) : nameOnOtherTeamMessage(conflict.name))));
    confirmedNames = confirmed;
  }
  if (problems.length > 0) throw new ClubTeamError("TEAM_RULES", problems.join(" "), problems);
  if (confirmedNames.length > 0 && options.actorUserId) {
    await writeAuditLog({
      eventId: team.eventId,
      actorUserId: options.actorUserId,
      action: "CLUB_TEAM_DIFFERENT_PERSON_CONFIRMED",
      entityType: "Registration",
      entityId: registrationId,
      summary: `Staff confirmed ${confirmedNames.join(", ")} as a different person from someone with the same name on another team of the club.`,
      metadata: { names: confirmedNames } as unknown as Prisma.InputJsonValue,
    }, tx);
  }

  // Team members of 18 or older are flagged for the Area Coordinator's permission: a flag, never a block, except that a
  // declined person must become a coach or leave before the team can be saved again.
  const flags = await syncTeamMemberPermissions(tx, {
    eventId: team.eventId, clubEventRegistrationId: team.id, registrationId, people: flagCandidates,
    actor: { userId: options.actorUserId, accountId: options.actorAccountId },
  });
  const scope = options.declineScope ?? "ANY";
  const blocking = scope === "ANY" ? flags.declined : flags.declined.filter((entry) => options.changedAttendeeIds?.has(entry.attendeeId));
  if (blocking.length > 0) {
    const messages = scope === "ANY" ? blocking.map((entry) => permissionDeclinedProblem(entry.name, entry.tlt)) : [permissionDeclinedGenericProblem];
    throw new ClubTeamError("TEAM_RULES", messages.join(" "), messages);
  }
  return { queuedMessageIds: flags.queuedMessageIds };
}
