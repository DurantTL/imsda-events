import { formatCalendarDate } from "@/modules/club-registrations/domain";
import type { TeamSettings } from "@/modules/club-teams/domain";

/**
 * The rules a team must keep (#809): how many team members it has, who the alternate is, and how old a team member
 * may be on the event's age date. Pure, so the director's page and the server (submit and amend) read one rule.
 *
 * A team member is anyone who is not a coach (see `teamRoleFor`). Coaches (the adults who come with the team) are listed
 * with it but never counted toward its size, never its alternate, and never held to the oldest age.
 */

export type TeamRole = "MEMBER" | "COACH";

/** The attendee form answer that names the alternate (a checkbox). */
export const ALTERNATE_FIELD_KEY = "alternate";

/** The attendee form answer that holds a person's role, shared with every club form's roster role question. */
export const ROLE_FIELD_KEY = "attendee_type";

/** Whether an attendee is marked the alternate: a checked box (or the words Yes/true a stored answer may carry). */
export function isAlternateAnswer(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return ["yes", "true"].includes(value.trim().toLowerCase());
  return false;
}

/** A role answer (or roster class level) that names a Pathfinder or a TLT: a youth member, even at 18 or 19. */
function isYouthRoleAnswer(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const answer = value.trim().toLowerCase();
  return answer === "pathfinder" || answer === "tlt" || answer === "teen leader in training";
}

/**
 * Whether a person is a team member or a coach, the same rule for roster people and extra people (#809), by their age on
 * the event's age date, so a director cannot dodge the size limit by marking a child as staff:
 * - under 18 is a team member, whatever the roster says;
 * - 18 up to the oldest team member age is a team member when the role answer is Pathfinder or TLT (or the roster class
 *   level is TLT), otherwise a coach;
 * - older than that is a coach;
 * - an age that is not known follows the roster type (staff and adults are coaches, everyone else a team member).
 */
export function teamRoleFor(input: {
  responses: Readonly<Record<string, unknown>>;
  rosterAttendeeType?: "YOUTH" | "STAFF" | "ADULT" | "UNDERAGE" | null;
  rosterClassLevel?: string | null;
  maxMemberAge?: number | null;
  age: number | null;
}): TeamRole {
  if (input.age === null) {
    return input.rosterAttendeeType === "STAFF" || input.rosterAttendeeType === "ADULT" ? "COACH" : "MEMBER";
  }
  if (input.age < 18) return "MEMBER";
  if (input.maxMemberAge !== null && input.maxMemberAge !== undefined && input.age > input.maxMemberAge) return "COACH";
  return isYouthRoleAnswer(input.responses[ROLE_FIELD_KEY]) || input.rosterClassLevel === "TLT" ? "MEMBER" : "COACH";
}

/** One person on a team, as the rules read them. `age` is on the event's age date. */
export type TeamPerson = { name: string; role: TeamRole; alternate: boolean; age: number | null };

/** The date ages are counted on: the settings' own, else the event's first day. */
export function teamAgeDate(settings: Pick<TeamSettings, "ageAsOf"> | null, eventDate: string): string {
  return settings?.ageAsOf ?? eventDate;
}

const plural = (count: number, one: string, other = `${one}s`) => `${count} ${count === 1 ? one : other}`;

const personName = (person: TeamPerson) => person.name.trim() || "Someone";

/**
 * Every way a team breaks the event's rules, each in a sentence that names the person it is about, or an empty list.
 * An event without team settings, or a limit left blank, holds nothing to it.
 */
export function teamRuleProblems(
  settings: Pick<TeamSettings, "minTeamMembers" | "maxTeamMembers" | "maxAlternates" | "maxMemberAge" | "ageAsOf"> | null,
  people: readonly TeamPerson[],
  eventDate: string,
): string[] {
  if (!settings) return [];
  const problems: string[] = [];
  const members = people.filter((person) => person.role === "MEMBER");
  const coaches = people.filter((person) => person.role === "COACH");
  const coachNote = coaches.length > 0 ? " Coaches don't count." : "";

  if (settings.minTeamMembers !== null && members.length < settings.minTeamMembers) {
    problems.push(`A team needs at least ${plural(settings.minTeamMembers, "team member")}; this one has ${members.length}.${coachNote} Add team members from your roster or as extra people.`);
  }
  if (settings.maxTeamMembers !== null && members.length > settings.maxTeamMembers) {
    const alternateNote = settings.maxAlternates > 0 ? ", including the alternate" : "";
    problems.push(`A team can have at most ${plural(settings.maxTeamMembers, "team member")}${alternateNote}; this one has ${members.length}.${coachNote} Remove ${plural(members.length - settings.maxTeamMembers, "team member")}.`);
  }

  for (const coach of coaches.filter((person) => person.alternate)) {
    problems.push(`${personName(coach)} is a coach, so can't be the alternate. Untick Alternate for them.`);
  }
  const alternates = members.filter((person) => person.alternate);
  if (settings.maxAlternates === 0 && alternates.length > 0) {
    problems.push(`This event has no alternate, so ${alternates.map(personName).join(" and ")} can't be marked the alternate.`);
  } else if (alternates.length > settings.maxAlternates) {
    const names = alternates.map(personName).join(", ");
    problems.push(`Only ${plural(settings.maxAlternates, "team member")} can be the alternate, but ${alternates.length} are marked: ${names}. Untick Alternate for the others.`);
  }

  if (settings.maxMemberAge !== null) {
    const date = formatCalendarDate(teamAgeDate(settings, eventDate));
    for (const member of members) {
      if (member.age === null) {
        problems.push(`${personName(member)}'s age on ${date} isn't known, so the age limit can't be checked. Enter their age on ${date}.`);
      } else if (member.age > settings.maxMemberAge) {
        problems.push(`${personName(member)} is ${member.age} on ${date}, and a team member can be at most ${settings.maxMemberAge}. Make them a coach, or remove them from the team.`);
      }
    }
  }
  return problems;
}
