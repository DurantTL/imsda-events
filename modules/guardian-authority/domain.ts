import { ageOn, parseCalendarDate } from "@/modules/club-rosters/domain";
import { BIRTH_DATE_FIELD_KEYS } from "@/modules/forms/definition";
import { calendarDateInTimeZone } from "@/modules/forms/public-domain";

/**
 * Declared guardian authority (#131, narrow slice). Pure rules, shared by the public form, the server
 * and the staff review so they cannot disagree.
 *
 * The one rule: authority comes only from a recorded declaration. Nothing here reads household,
 * surname, email, `canManage` or the account holder to decide who is responsible for a minor. The
 * account holder appears below only to pick which adult is PRESELECTED on the form; the choice still
 * has to be submitted, and that submission is the declaration.
 */

export const DEFAULT_AGE_OF_MAJORITY = 18;
/** The form's "None of us" choice, sent in place of an adult's client id. */
export const RESPONSIBLE_ADULT_NONE = "NONE";
export const NONE_OF_US_LABEL = "None of us";
export const RESPONSIBLE_ADULT_REASON_MAX = 500;

export type PersonAge = { birthDate: string | null; statedAge: number | null };
export type MinorStatus = {
  /** UNKNOWN is never an adult: it goes to staff. */
  status: "MINOR" | "ADULT" | "UNKNOWN";
  age: number | null;
  basis: "BIRTH_DATE" | "STATED_AGE" | "NONE";
};

const AGE_ANSWER_KEYS = ["attendee_age", "age", "guest_age"] as const;

function wholeAge(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 130 ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{1,3})\s*(?:years?|yrs?|y)?\s*$/i.exec(value);
  if (!match) return null;
  const age = Number(match[1]);
  return age <= 130 ? age : null;
}

/**
 * What a registration says about someone's age: a birth date answered on the form (ISO date), or an age
 * already worked out for the event date (club and group snapshots), or a stated age answer. Nothing is guessed from
 * the attendee type or a label such as "child".
 */
export function personAgeFromAnswers(responses: Record<string, unknown>, snapshot: Record<string, unknown> = {}): PersonAge {
  let birthDate: string | null = null;
  for (const key of BIRTH_DATE_FIELD_KEYS) {
    const value = responses[key];
    if (typeof value === "string" && parseCalendarDate(value.trim())) {
      birthDate = value.trim();
      break;
    }
  }
  let statedAge = wholeAge(snapshot.ageOnEventDate);
  if (statedAge === null) {
    for (const key of AGE_ANSWER_KEYS) {
      const age = wholeAge(responses[key]);
      if (age !== null) {
        statedAge = age;
        break;
      }
    }
  }
  return { birthDate, statedAge };
}

/** The event's first day as a calendar date in its own time zone. */
export function eventStartDate(startsAt: Date | string, timezone: string) {
  return calendarDateInTimeZone(typeof startsAt === "string" ? new Date(startsAt) : startsAt, timezone);
}

/**
 * Minor, adult or unknown at the event's START date, so someone who turns 18 on day two is still a minor
 * for this event. A birth date decides first; a stated age (already "at the event") is the fallback. No age
 * at all is UNKNOWN: not an adult, and flagged for staff.
 */
export function minorStatusAt(age: PersonAge, startDate: string, ageOfMajority: number = DEFAULT_AGE_OF_MAJORITY): MinorStatus {
  let years: number | null = null;
  let basis: MinorStatus["basis"] = "NONE";
  if (age.birthDate) {
    const fromBirth = ageOn(age.birthDate, startDate);
    if (fromBirth !== null && fromBirth >= 0) {
      years = fromBirth;
      basis = "BIRTH_DATE";
    }
  }
  if (years === null && age.statedAge !== null) {
    years = age.statedAge;
    basis = "STATED_AGE";
  }
  if (years === null) return { status: "UNKNOWN", age: null, basis: "NONE" };
  return { status: years < ageOfMajority ? "MINOR" : "ADULT", age: years, basis };
}

// ---------------------------------------------------------------------------------------------
// The form's "Responsible adult" choice
// ---------------------------------------------------------------------------------------------

export type RosterPerson = {
  /** The attendee's client id on the form, or its attendee id once saved. */
  key: string;
  name: string;
  status: MinorStatus["status"];
  /** Only used to preselect an adult; never to grant authority. */
  isAccountHolder: boolean;
};

/**
 * True when `name` is the primary contact's name as typed in the registration-level answers
 * (`primary_first_name`/`primary_last_name`, or `first_name`/`last_name`). Used only to preselect the
 * account holder on the form; it never creates authority.
 */
export function sameFullName(name: string, registrationResponses: Readonly<Record<string, unknown>>) {
  const text = (key: string) => (typeof registrationResponses[key] === "string" ? (registrationResponses[key] as string).trim() : "");
  const pairs: Array<[string, string]> = [["primary_first_name", "primary_last_name"], ["first_name", "last_name"]];
  const normalized = name.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return false;
  return pairs.some(([first, last]) => {
    const contact = `${text(first)} ${text(last)}`.trim().replace(/\s+/g, " ").toLowerCase();
    return contact.length > 0 && contact === normalized;
  });
}

export function adultsOn(people: readonly RosterPerson[]) {
  return people.filter((person) => person.status === "ADULT");
}

export function minorsOn(people: readonly RosterPerson[]) {
  return people.filter((person) => person.status === "MINOR");
}

/**
 * The preselected choice for a minor: the only adult; else the account holder if they are an adult; else the
 * first adult listed; "None of us" when there is no adult at all. It is only a default: submitting the form with it
 * is the declaration.
 */
export function defaultResponsibleAdultKey(people: readonly RosterPerson[]): string {
  const adults = adultsOn(people);
  if (adults.length === 0) return RESPONSIBLE_ADULT_NONE;
  if (adults.length === 1) return adults[0]!.key;
  return (adults.find((person) => person.isAccountHolder) ?? adults[0]!).key;
}

export type ResponsibleAdultIssueCode = "RESPONSIBLE_ADULT_REQUIRED" | "RESPONSIBLE_ADULT_INVALID";
export type ResponsibleAdultIssue = { code: ResponsibleAdultIssueCode; minorKey: string; message: string };

/**
 * Checks one choice per minor: every minor has one (never blank), and it is "None of us" or an adult on this same
 * registration (never the minor themselves, never another minor, never someone not on the registration). A choice
 * for someone who is not a minor is ignored: it creates nothing.
 */
export function validateResponsibleAdultChoices(
  people: readonly RosterPerson[],
  choices: Readonly<Record<string, string>>,
): { issues: ResponsibleAdultIssue[]; declarations: Array<{ minorKey: string; adultKey: string | null }> } {
  const adultKeys = new Set(adultsOn(people).map((person) => person.key));
  const issues: ResponsibleAdultIssue[] = [];
  const declarations: Array<{ minorKey: string; adultKey: string | null }> = [];
  for (const minor of minorsOn(people)) {
    const choice = Object.hasOwn(choices, minor.key) ? choices[minor.key] : undefined;
    if (choice === undefined || choice === "") {
      issues.push({ code: "RESPONSIBLE_ADULT_REQUIRED", minorKey: minor.key, message: `Choose a responsible adult for ${minor.name}, or “${NONE_OF_US_LABEL}”.` });
    } else if (choice === RESPONSIBLE_ADULT_NONE) {
      declarations.push({ minorKey: minor.key, adultKey: null });
    } else if (adultKeys.has(choice) && choice !== minor.key) {
      declarations.push({ minorKey: minor.key, adultKey: choice });
    } else {
      issues.push({ code: "RESPONSIBLE_ADULT_INVALID", minorKey: minor.key, message: `The responsible adult for ${minor.name} must be an adult on this registration.` });
    }
  }
  return { issues, declarations };
}

// ---------------------------------------------------------------------------------------------
// Staff review
// ---------------------------------------------------------------------------------------------

export type ReviewKind =
  | "NONE_OF_US"
  | "NO_ADULT_ON_REGISTRATION"
  | "UNKNOWN_AGE"
  | "NOT_DECLARED"
  | "ADULT_LEFT_REGISTRATION"
  | "CONFLICT";

export const reviewKindLabels: Record<ReviewKind, string> = {
  NONE_OF_US: "Registrant chose “None of us”",
  NO_ADULT_ON_REGISTRATION: "Minor on a registration with no adult",
  UNKNOWN_AGE: "Age unknown",
  NOT_DECLARED: "No responsible adult recorded",
  ADULT_LEFT_REGISTRATION: "Responsible adult is no longer on the registration",
  CONFLICT: "Two adults claim this minor",
};

export type ReviewAuthority = {
  id: string;
  adultPersonId: string | null;
  source: "REGISTRATION_FORM" | "STAFF";
};

export type ReviewPerson = {
  attendeeId: string;
  personId: string;
  registrationId: string;
  status: MinorStatus["status"];
  /** The persons on the minor's registration who are adults at the event start. */
  registrationAdultPersonIds: readonly string[];
  /** Everyone on the minor's registration, so a departed adult can be told from a present one. */
  registrationPersonIds: readonly string[];
  authority: ReviewAuthority | null;
  openConflictIds: readonly string[];
};

/**
 * The reasons a person needs staff attention. A person can have several. Nothing here blocks anyone: it is a
 * list for staff, and a minor with a recorded adult and no flags is simply not listed.
 */
export function reviewKindsFor(person: ReviewPerson): ReviewKind[] {
  if (person.status === "ADULT") return [];
  const kinds: ReviewKind[] = [];
  if (person.status === "UNKNOWN") kinds.push("UNKNOWN_AGE");
  if (person.status === "MINOR") {
    const authority = person.authority;
    if (authority && authority.adultPersonId === null) kinds.push("NONE_OF_US");
    if (authority?.adultPersonId && authority.source === "REGISTRATION_FORM" && !person.registrationPersonIds.includes(authority.adultPersonId)) {
      kinds.push("ADULT_LEFT_REGISTRATION");
    }
    // A staff-set adult elsewhere in the event answers the "no adult on this registration" question.
    const hasRecordedAdult = Boolean(authority?.adultPersonId);
    if (person.registrationAdultPersonIds.length === 0 && !hasRecordedAdult) kinds.push("NO_ADULT_ON_REGISTRATION");
    else if (!authority) kinds.push("NOT_DECLARED");
  }
  if (person.openConflictIds.length > 0) kinds.push("CONFLICT");
  return kinds;
}

/** The adult staff and lodging may use for a minor: the ACTIVE declaration's adult, or null. */
export function responsibleAdultPersonId(authority: ReviewAuthority | null): string | null {
  return authority?.adultPersonId ?? null;
}

/** What a declaration does when it arrives (pure: the repository applies the plan inside a lock). */
export type DeclarationPlan =
  | { kind: "CREATE" }
  | { kind: "UNCHANGED" }
  | { kind: "SUPERSEDE" }
  | { kind: "CONFLICT" }
  | { kind: "IGNORE" };

/**
 * A registration-form declaration against the most recent record for the minor at this event (if any). That is
 * the ACTIVE one, or a staff revocation that nothing has followed:
 *  - none yet: create it;
 *  - the same adult again: unchanged;
 *  - the registrant's own earlier declaration, from the same registration, with a different adult or "None of us":
 *    the registrant changed their mind, so it supersedes;
 *  - anything staff did (set or revoked), or a different registration naming a different adult: a review item for
 *    staff, never a silent replacement. A registrant cannot undo a staff decision;
 *  - "None of us" against someone else's record claims nothing, so nothing changes.
 */
export function planRegistrationDeclaration(
  latest: { registrationId: string; adultPersonId: string | null; source: "REGISTRATION_FORM" | "STAFF"; state: "ACTIVE" | "REVOKED" } | null,
  next: { registrationId: string; adultPersonId: string | null },
): DeclarationPlan {
  if (!latest) return { kind: "CREATE" };
  if (latest.state === "REVOKED") return next.adultPersonId === null ? { kind: "IGNORE" } : { kind: "CONFLICT" };
  if (latest.adultPersonId === next.adultPersonId && (latest.registrationId === next.registrationId || next.adultPersonId !== null)) {
    return { kind: "UNCHANGED" };
  }
  if (latest.source === "REGISTRATION_FORM" && latest.registrationId === next.registrationId) return { kind: "SUPERSEDE" };
  return next.adultPersonId === null ? { kind: "IGNORE" } : { kind: "CONFLICT" };
}

// ---------------------------------------------------------------------------------------------
// The public form, checked on the server
// ---------------------------------------------------------------------------------------------

export type SubmittedAttendee = { clientId: string; name: string; responses: Record<string, unknown> };

export type PublicResponsibleAdultPlan = {
  /** Anyone on the form who is a minor at the event start (empty: no choice is asked or recorded). */
  minorKeys: string[];
  issues: Array<{ code: ResponsibleAdultIssueCode; message: string; attendeeIndex: number; path: string; key: "responsible_adult" }>;
  declarations: Array<{ minorKey: string; adultKey: string | null }>;
};

/**
 * Decides, from the answers the server received, who is a minor at the event start and whether the submitted
 * "Responsible adult" choices are valid. The browser's own idea of who is a minor is never trusted: a minor with
 * no choice is refused, and a choice naming anyone but an adult on this registration is refused.
 */
export function planPublicResponsibleAdults(input: {
  startDate: string;
  ageOfMajority: number;
  attendees: readonly SubmittedAttendee[];
  choices: Readonly<Record<string, string>> | undefined;
}): PublicResponsibleAdultPlan {
  const people: RosterPerson[] = input.attendees.map((attendee) => ({
    key: attendee.clientId,
    name: attendee.name || "this attendee",
    status: minorStatusAt(personAgeFromAnswers(attendee.responses), input.startDate, input.ageOfMajority).status,
    isAccountHolder: false,
  }));
  const minors = minorsOn(people);
  if (minors.length === 0) return { minorKeys: [], issues: [], declarations: [] };
  const { issues, declarations } = validateResponsibleAdultChoices(people, input.choices ?? {});
  const indexOf = new Map(input.attendees.map((attendee, index) => [attendee.clientId, index]));
  return {
    minorKeys: minors.map((minor) => minor.key),
    issues: issues.map((issue) => {
      const attendeeIndex = indexOf.get(issue.minorKey) ?? 0;
      return { code: issue.code, message: issue.message, attendeeIndex, path: `attendees.${attendeeIndex}.responsibleAdult`, key: "responsible_adult" as const };
    }),
    declarations,
  };
}
