import { z } from "zod";
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

const GUEST_PREFIX = "guest:";

/**
 * Someone going who isn't on the roster (#388), e.g. a parent driver. For
 * this event only: never added to the roster or kept for another event.
 */
export type ClubGuest = { id: string; firstName: string; lastName: string; age: number; email: string | null };

export const MAX_CLUB_GUESTS = 25;

export const clubGuestSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{6,24}$/, "Refresh the page and add the person again."),
  firstName: z.string().trim().min(1, "Enter a first name.").max(80),
  lastName: z.string().trim().min(1, "Enter a last name.").max(80),
  age: z.number().int("Enter the age in whole years.").min(0, "Enter an age from 0 to 120.").max(120, "Enter an age from 0 to 120."),
  email: z.string().trim().toLowerCase().email("Enter a valid email, or leave it blank.").max(254).nullable()
    .or(z.literal("").transform(() => null)),
}).strict();

export const clubGuestsSchema = z.array(clubGuestSchema).max(MAX_CLUB_GUESTS, `Add up to ${MAX_CLUB_GUESTS} extra people.`);

/**
 * H3b (#366): a director reopens a submitted club registration to add or
 * remove roster people and extra people, or change their answers, before the
 * event's registration deadline. `keptGuestIds` names the extra people
 * already on the registration to keep (their `clubGuestId`, or the attendee
 * id for one submitted before guests carried one); `newGuests` are brand-new
 * extra people this edit adds. `keptOffRosterAttendeeIds` names registered
 * people who are no longer on the club's active roster and should stay
 * (required, so a client can never drop them by leaving the list out).
 * `attendeeResponses` is keyed by client id: a roster person by
 * `clubAttendeeClientId`, a guest (kept or new) by `clubGuestClientId`, an
 * off-roster person by `clubExistingAttendeeClientId`.
 */
export const clubRegistrationEditInputSchema = z.object({
  clientRequestId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
  selectedMemberIds: z.array(z.string().trim().min(1)).max(500),
  keptGuestIds: z.array(z.string().trim().min(1).max(100)).max(MAX_CLUB_GUESTS),
  keptOffRosterAttendeeIds: z.array(z.string().trim().min(1).max(100)).max(500),
  newGuests: clubGuestsSchema,
  attendeeResponses: z.record(z.string(), z.record(z.string(), z.unknown())),
}).strict();

export type ClubRegistrationEditInput = z.infer<typeof clubRegistrationEditInputSchema>;

/** Guests saved in a draft, dropping anything that no longer reads as one. */
export function guestsFromJson(value: unknown): ClubGuest[] {
  const parsed = clubGuestsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function clubGuestClientId(guestId: string) {
  return `${GUEST_PREFIX}${guestId}`;
}

export function guestIdFromClientId(clientId: string) {
  return clientId.startsWith(GUEST_PREFIX) ? clientId.slice(GUEST_PREFIX.length) : null;
}

const EXISTING_PREFIX = "attendee:";

/**
 * A registered person who is no longer on the club's active roster (H3b,
 * #366), keyed by their registration attendee id: kept as registered, with
 * no roster lookup.
 */
export function clubExistingAttendeeClientId(attendeeId: string) {
  return `${EXISTING_PREFIX}${attendeeId}`;
}

/** Adults among guests are background-checked like everyone else. */
export function guestIsAdult(guest: Pick<ClubGuest, "age">) {
  return guest.age >= 18;
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

const FREE_TEXT_FIELD_TYPES = new Set<RegistrationFormField["type"]>(["TEXT", "LONG_TEXT"]);

// A narrower subset of `sensitiveFieldPattern` in
// modules/attendee-accounts/registration-answer-policy.ts (ADR 0005 §5): it
// leaves out "dietary", "age", "emergency" and the like, so the Camporee's
// "Dietary restrictions" convenience field (ADR 0005 §1) stays allowed. Food
// allergies may be listed as free text (decided on PR #418), so "allergy" is
// not a trigger word either. Only free text is checked, so the "Medical
// personnel?" checkbox and the yes/no medical-need flag never match.
const MEDICAL_FREE_TEXT_PATTERN =
  /\b(?:medic\w*|meds?|health|accessib\w*|disabil\w*|special\s*needs?|insur\w*)\b/i;

function looksLikeMedicalFreeText(field: RegistrationFormField) {
  // Snake_case keys become words so `medical_info` matches as well as its label.
  return MEDICAL_FREE_TEXT_PATTERN.test(`${field.key.replaceAll("_", " ")} ${field.label}`);
}

/**
 * Free-text attendee fields that read as medical/health notes (#408).
 * Registration answers are stored unencrypted, so club registration refuses
 * to collect this kind of detail; only structured fields (checkbox, select,
 * yes/no) are allowed to carry it.
 */
export function medicalFreeTextFields(definition: RegistrationFormDefinition): RegistrationFormField[] {
  return attendeeFields(definition)
    .filter((field) => FREE_TEXT_FIELD_TYPES.has(field.type) && looksLikeMedicalFreeText(field));
}

/** Why a published form can't be used for club registration, or null. */
export function clubFormProblem(definition: RegistrationFormDefinition) {
  if (!definition.attendeeRoster?.enabled) return "The event's form doesn't collect a list of attendees.";
  if (!attendeeNameKeys(definition)) return "The event's form has no attendee name fields.";
  if (birthDateFields(definition).length > 0) {
    return "The event's form asks for birth dates. Club registration uses the roster's age instead, so remove that question.";
  }
  const medicalFields = medicalFreeTextFields(definition);
  if (medicalFields.length > 0) {
    const labels = medicalFields.map((field) => `"${field.label}"`).join(", ");
    return `The event's form asks attendees a free-text medical, health, or accessibility question (${labels}). Registration answers aren't encrypted, so replace it with a checkbox or yes/no question and republish.`;
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

/**
 * Whether a director may still reopen a submitted club registration (H3b,
 * #366): only while registration is open, judged in the event's own time
 * zone, the same "open" the submit path requires. An event with no closing
 * date stays editable through its start date and closes the day after.
 * `today` and `eventDate` are calendar dates in the event's time zone.
 */
export function clubRegistrationEditWindow(input: {
  phase: "DRAFT" | "UPCOMING" | "OPEN" | "CLOSED";
  registrationClosesOn: string | null;
  today: string;
  eventDate: string;
}): { open: true } | { open: false; message: string } {
  if (input.phase === "UPCOMING" || input.phase === "DRAFT") {
    return { open: false, message: "Registration for this event isn't open, so your registration can't be changed right now. Contact the event team." };
  }
  if (input.phase === "CLOSED") {
    const closing = input.registrationClosesOn ? ` after ${formatCalendarDate(input.registrationClosesOn)}` : "";
    return { open: false, message: `Registration closed${closing}. Contact the event team to add or remove someone.` };
  }
  if (!input.registrationClosesOn && input.today > input.eventDate) {
    return { open: false, message: "This event is under way, so your registration can't be changed here. Contact the event team to add or remove someone." };
  }
  return { open: true };
}

/** "2026-12-05" as "December 5, 2026", without letting a time zone move the day. */
export function formatCalendarDate(calendarDate: string) {
  const [year, month, day] = calendarDate.split("-").map(Number);
  if (!year || !month || !day) return calendarDate;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "long", day: "numeric", year: "numeric",
  });
}

