import { z } from "zod";
import { isAgeFieldKey, type RegistrationFormDefinition, type RegistrationFormField } from "@/modules/forms/definition";
import { normalizeOrganizationName } from "@/modules/organizations/domain";
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

export function attendeeAgeKey(definition: RegistrationFormDefinition) {
  return attendeeFields(definition).find((field) => field.type === "NUMBER" && isAgeFieldKey(field.key))?.key ?? null;
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

/**
 * The club and its sponsoring church, read from the `Organization` record a
 * signed-in director actually directs — never from anything the client sent
 * (#482). `churchName` is null when the club has no sponsoring church on
 * file, or that church is no longer active.
 */
export type ClubDirectoryIdentity = { clubName: string; churchName: string | null };

function registrationFields(definition: RegistrationFormDefinition) {
  return definition.sections.flatMap((section) => section.fields).filter((field) => field.scope === "REGISTRATION");
}

/** The field's own spelling of `name` when the directory lists it under a
 * slightly different form (case, spacing), else `name` as is. */
function directoryChoice(field: RegistrationFormField, name: string) {
  const normalized = normalizeOrganizationName(name);
  return field.options.find((option) => normalizeOrganizationName(option) === normalized) ?? name;
}

/**
 * Registration-scope field keys a club registration locks to the
 * authenticated director's own club (#482): only the "Clubs directory"
 * field — "the club itself is locked". The church is prefilled but stays
 * editable (`clubDirectoryPrefillResponses`). Same "locked, never trust the
 * client" pattern as `lockedAttendeeFieldKeys` for roster-owned answers.
 */
export function lockedClubDirectoryFieldKeys(definition: RegistrationFormDefinition): string[] {
  return registrationFields(definition)
    .filter((field) => field.optionSource === "CLUBS_DIRECTORY")
    .map((field) => field.key);
}

/**
 * The registration-scope answers a club registration owns outright: the
 * "Clubs directory" field, always the director's actual club, with its
 * paired "Not listed" free-text companion cleared since a real directory
 * match is known. Applied server-side on submit (like `rosterOwnedResponses`
 * for attendees) and on amendment, so nothing the client sent for the club
 * ever reaches storage. The church is deliberately not included.
 */
export function clubDirectoryOwnedResponses(
  definition: RegistrationFormDefinition,
  identity: ClubDirectoryIdentity,
): Record<string, string | null> {
  const responses: Record<string, string | null> = {};
  if (!identity.clubName) return responses;
  const fields = registrationFields(definition);
  for (const field of fields) {
    if (field.optionSource !== "CLUBS_DIRECTORY") continue;
    responses[field.key] = directoryChoice(field, identity.clubName);
    // The free-text "Not listed" companion (the existing "show only when"
    // convention) no longer applies once the field is locked to a real
    // directory match, so clear it rather than leaving a stale answer.
    const companion = fields.find((candidate) => candidate.conditional?.fieldKey === field.key);
    if (companion) responses[companion.key] = null;
  }
  return responses;
}

/**
 * What a new club registration opens with (#482): the locked club, plus the
 * club's sponsoring church as an editable default in any "Churches
 * directory" field. No church on file, or an inactive one, leaves the church
 * blank for the director to choose.
 */
export function clubDirectoryPrefillResponses(
  definition: RegistrationFormDefinition,
  identity: ClubDirectoryIdentity,
): Record<string, string> {
  const prefill: Record<string, string> = {};
  for (const [key, value] of Object.entries(clubDirectoryOwnedResponses(definition, identity))) {
    if (value) prefill[key] = value;
  }
  if (identity.churchName) {
    for (const field of registrationFields(definition)) {
      if (field.optionSource === "CHURCHES_DIRECTORY") prefill[field.key] = directoryChoice(field, identity.churchName);
    }
  }
  return prefill;
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

// Staff, adult, and underage prefill from the roster's own attendee type,
// since that's read directly off the roster rather than guessed among many
// options. Youth are never guessed this way (#483): a youth's role only
// prefills when the roster's own role matches a configured option, and a
// blank or unrecognized youth role (e.g. "Teen Leader") is left for the
// director to pick — never silently defaulted to a role like Pathfinder.
const TYPE_OPTION_NAMES: Record<string, string[]> = {
  STAFF: ["staff"],
  ADULT: ["adult", "staff"],
  UNDERAGE: ["child", "underage"],
};

function roleField(definition: RegistrationFormDefinition) {
  return attendeeFields(definition).find((candidate) => (
    candidate.key === "attendee_type" && ["RADIO", "SELECT"].includes(candidate.type) && candidate.options.length > 0
  )) ?? null;
}

function optionsByName(field: RegistrationFormField) {
  return new Map(field.options.map((option) => [option.trim().toLowerCase(), option]));
}

/**
 * A starting answer for the form's roster-role question (e.g. Pathfinder,
 * TLT, Staff, Child), so a director doesn't re-pick it for every person. The
 * roster's own role wins when it matches an option; otherwise its type does
 * (staff, adult, underage only — see above). Only a prefill: the director
 * can still change it. A role that doesn't match, or a blank youth role,
 * prefills nothing; `unmatchedRosterRole` reports the former so the form can
 * prompt for it instead of leaving it silently blank (#483).
 */
export function rosterRolePrefill(definition: RegistrationFormDefinition, person: RosterPerson) {
  const field = roleField(definition);
  if (!field) return {};
  const byName = optionsByName(field);
  const role = person.role?.trim().toLowerCase();
  const fromRole = role ? byName.get(role) : undefined;
  const typeNames = person.attendeeType ? TYPE_OPTION_NAMES[person.attendeeType] ?? [] : [];
  const fromType = fromRole ? undefined : typeNames.map((name) => byName.get(name)).find(Boolean);
  const option = fromRole ?? fromType;
  return option ? { [field.key]: option } : {};
}

/**
 * The roster's carried-over role, when it's given but doesn't match any of
 * the form's configured role options (e.g. "Teen Leader") — never silently
 * dropped or defaulted (#483). Null when the role is blank or matches.
 */
export function unmatchedRosterRole(definition: RegistrationFormDefinition, person: Pick<RosterPerson, "role">): string | null {
  const field = roleField(definition);
  if (!field) return null;
  const role = person.role?.trim();
  if (!role) return null;
  return optionsByName(field).has(role.toLowerCase()) ? null : role;
}

/**
 * The roster's carried-over gender, when it's given but the form's gender
 * field offers no matching option — never silently dropped (#483). Null when
 * there's no gender, or it matches.
 */
export function unmatchedRosterGender(definition: RegistrationFormDefinition, person: Pick<RosterPerson, "gender">): string | null {
  if (!person.gender) return null;
  const field = attendeeFields(definition).find((candidate) => candidate.key === "gender");
  if (!field) return null;
  const wanted = person.gender === "FEMALE" ? "female" : "male";
  const matched = field.options.some((option) => option.trim().toLowerCase() === wanted);
  return matched ? null : (person.gender === "FEMALE" ? "Female" : "Male");
}

export type RosterCarryoverMismatch = { fieldKey: string; label: string; value: string };

/**
 * Every roster-carried value that doesn't match a configured form option, so
 * the form can show "Couldn't match '…' — pick one" instead of leaving the
 * field silently blank (#483).
 */
export function rosterCarryoverMismatches(definition: RegistrationFormDefinition, person: RosterPerson): RosterCarryoverMismatch[] {
  const mismatches: RosterCarryoverMismatch[] = [];
  const role = unmatchedRosterRole(definition, person);
  const roleFieldRef = roleField(definition);
  if (role && roleFieldRef) mismatches.push({ fieldKey: roleFieldRef.key, label: roleFieldRef.label, value: role });
  const gender = unmatchedRosterGender(definition, person);
  const genderFieldRef = attendeeFields(definition).find((candidate) => candidate.key === "gender");
  if (gender && genderFieldRef) mismatches.push({ fieldKey: genderFieldRef.key, label: genderFieldRef.label, value: gender });
  return mismatches;
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

