import { formatCalendarDate } from "@/modules/club-registrations/domain";
import type { TeamSettings } from "@/modules/club-teams/domain";

/**
 * The rules a team must keep (#809): how many team members it has, who the alternate is, and how old a team member
 * may be on the event's age date. Pure, so the director's page and the server (submit and amend) read one rule.
 *
 * A team member is anyone who is not a coach. Coaches (the adults who come with the team) are listed with it but
 * never counted toward its size, never its alternate, and never held to the oldest age.
 */

export type TeamRole = "MEMBER" | "COACH";

/** The attendee form answer that names the alternate (a checkbox). */
export const ALTERNATE_FIELD_KEY = "alternate";

/** The attendee form answer that holds a person's role, shared with every club form's roster role question. */
export const ROLE_FIELD_KEY = "attendee_type";

const COACH_ROLE_ANSWERS = new Set(["coach", "staff", "adult"]);

/** Whether an attendee is marked the alternate: a checked box (or the words Yes/true a stored answer may carry). */
export function isAlternateAnswer(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return ["yes", "true"].includes(value.trim().toLowerCase());
  return false;
}

/**
 * Whether a person is a coach: an adult who comes with the team. A roster person is what the roster says (staff and adults
 * are coaches, youth and children are team members), whatever the form's role answer, so a director cannot turn a youth
 * into a coach to keep them out of the count. An extra person under 18 is a team member; one who is 18 or older is a coach
 * unless the director gave them a team member's role (a Pathfinder or TLT of 18 or 19 from a partner club).
 */
export function teamRoleFor(input: {
  responses: Readonly<Record<string, unknown>>;
  rosterAttendeeType?: "YOUTH" | "STAFF" | "ADULT" | "UNDERAGE" | null;
  age: number | null;
}): TeamRole {
  if (input.rosterAttendeeType) return input.rosterAttendeeType === "STAFF" || input.rosterAttendeeType === "ADULT" ? "COACH" : "MEMBER";
  if (input.age === null || input.age < 18) return "MEMBER";
  const answer = input.responses[ROLE_FIELD_KEY];
  if (typeof answer === "string" && answer.trim()) return COACH_ROLE_ANSWERS.has(answer.trim().toLowerCase()) ? "COACH" : "MEMBER";
  return "COACH";
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
