import type { RegistrationFormDefinition, RegistrationFormField } from "@/modules/forms/definition";
import { fullNameKeys, splitNameKeyPairs } from "@/modules/forms/public-domain";

/**
 * Club registration (#358): how roster people map onto an event's published
 * form. Pure, so the director's page and the server agree on every field.
 */

const MEMBER_PREFIX = "member:";

export function clubAttendeeClientId(rosterMemberId: string) {
  return `${MEMBER_PREFIX}${rosterMemberId}`;
}

export function rosterMemberIdFromClientId(clientId: string) {
  return clientId.startsWith(MEMBER_PREFIX) ? clientId.slice(MEMBER_PREFIX.length) : null;
}

function attendeeFields(definition: RegistrationFormDefinition) {
  return definition.sections.flatMap((section) => section.fields).filter((field) => field.scope === "ATTENDEE");
}

export type AttendeeNameKeys =
  | { kind: "split"; first: string; last: string }
  | { kind: "full"; key: string };

export function attendeeNameKeys(definition: RegistrationFormDefinition): AttendeeNameKeys | null {
  const keys = new Set(attendeeFields(definition).map((field) => field.key));
  const pair = splitNameKeyPairs.find((candidate) => keys.has(candidate.first) && keys.has(candidate.last));
  if (pair) return { kind: "split", first: pair.first, last: pair.last };
  const full = fullNameKeys.find((key) => keys.has(key));
  return full ? { kind: "full", key: full } : null;
}

const AGE_KEYS = ["attendee_age", "age"];

export function attendeeAgeKey(definition: RegistrationFormDefinition) {
  return attendeeFields(definition).find((field) => field.type === "NUMBER" && AGE_KEYS.includes(field.key))?.key ?? null;
}

const BIRTH_DATE_PATTERN = /birth|\bdob\b/i;

/** Fields that would copy a birth date into registration answers. Club registration refuses such forms. */
export function birthDateFields(definition: RegistrationFormDefinition): RegistrationFormField[] {
  return definition.sections.flatMap((section) => section.fields)
    .filter((field) => BIRTH_DATE_PATTERN.test(field.key) || BIRTH_DATE_PATTERN.test(field.label));
}

/** Why a published form can't be used for club registration, or null. */
export function clubFormProblem(definition: RegistrationFormDefinition) {
  if (!definition.attendeeRoster?.enabled) return "The event's form doesn't collect a list of attendees.";
  if (!attendeeNameKeys(definition)) return "The event's form has no attendee name fields.";
  if (birthDateFields(definition).length > 0) {
    return "The event's form asks for birth dates. Club registration uses the roster's age instead, so remove that question.";
  }
  return null;
}

export function lockedAttendeeFieldKeys(definition: RegistrationFormDefinition) {
  const names = attendeeNameKeys(definition);
  const age = attendeeAgeKey(definition);
  return [
    ...(names?.kind === "split" ? [names.first, names.last] : names ? [names.key] : []),
    ...(age ? [age] : []),
  ];
}

export type RosterPerson = {
  firstName: string;
  lastName: string;
  ageOnEventDate: number | null;
  gender: "FEMALE" | "MALE" | null;
  role?: string;
  attendeeType?: "YOUTH" | "STAFF" | "ADULT" | "UNDERAGE";
};

/** The roster-owned answers for one attendee. Names and age always come from the roster. */
export function rosterOwnedResponses(definition: RegistrationFormDefinition, person: RosterPerson) {
  const responses: Record<string, string> = {};
  const names = attendeeNameKeys(definition);
  if (names?.kind === "split") {
    responses[names.first] = person.firstName;
    responses[names.last] = person.lastName;
  } else if (names) {
    responses[names.key] = `${person.firstName} ${person.lastName}`.trim();
  }
  const age = attendeeAgeKey(definition);
  if (age && person.ageOnEventDate !== null) responses[age] = String(person.ageOnEventDate);
  return responses;
}

/** A starting answer for gender when the form asks and offers a matching option. */
export function rosterGenderPrefill(definition: RegistrationFormDefinition, person: RosterPerson) {
  if (!person.gender) return {};
  const field = attendeeFields(definition).find((candidate) => candidate.key === "gender");
  const wanted = person.gender === "FEMALE" ? "female" : "male";
  const option = field?.options.find((candidate) => candidate.toLowerCase() === wanted);
  return field && option ? { [field.key]: option } : {};
}

const TYPE_OPTION_NAMES: Record<string, string[]> = {
  STAFF: ["staff"],
  ADULT: ["adult", "staff"],
  UNDERAGE: ["child", "underage"],
};

/**
 * A starting answer for the form's roster-role question (e.g. Pathfinder,
 * TLT, Staff, Child), so a director doesn't re-pick it for every person. The
 * roster's own role wins when it matches an option; otherwise its type does.
 * Only a prefill: the director can still change it.
 */
export function rosterRolePrefill(definition: RegistrationFormDefinition, person: RosterPerson) {
  const field = attendeeFields(definition).find((candidate) => (
    candidate.key === "attendee_type" && ["RADIO", "SELECT"].includes(candidate.type) && candidate.options.length > 0
  ));
  if (!field) return {};
  const byName = new Map(field.options.map((option) => [option.trim().toLowerCase(), option]));
  const role = person.role?.trim().toLowerCase();
  const fromRole = role ? byName.get(role) : undefined;
  const fromType = person.attendeeType
    ? (TYPE_OPTION_NAMES[person.attendeeType] ?? []).map((name) => byName.get(name)).find(Boolean)
    : undefined;
  const option = fromRole ?? fromType;
  return option ? { [field.key]: option } : {};
}

/** "2026-12-05" as "December 5, 2026", without letting a time zone move the day. */
export function formatCalendarDate(calendarDate: string) {
  const [year, month, day] = calendarDate.split("-").map(Number);
  if (!year || !month || !day) return calendarDate;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "long", day: "numeric", year: "numeric",
  });
}

