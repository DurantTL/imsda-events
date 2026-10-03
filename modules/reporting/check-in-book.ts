import {
  registrationFormDefinitionSchema,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { attendeeAgeKey } from "@/modules/club-registrations/domain";
import { withLocationColumn, type ClubEventRecord } from "@/modules/reporting/club-event-reports";
import { isSensitiveField, sensitiveFieldPattern } from "@/modules/forms/sensitive-fields";
import { isLinkedToBlockedField } from "@/modules/forms/field-dependency-walk";
import { isFieldSensitive, sectionTitleLookup } from "@/modules/forms/field-flags";
import { toCsv } from "@/modules/reporting/csv";

/**
 * The paper check-in book (#600): one printable page per club, or per
 * registration on events with no club registrations, with a check / didn't
 * come column, the campsite needs on top, and one staff-chosen extra column.
 * Pure, so the page, the CSV and the tests all build from the same data.
 *
 * Club headers reuse the club packet's camping answers (`camping.tents`,
 * `camping.kitchenCanopy`) and role abbreviations. The extra column may only
 * show a non-sensitive attendee answer; a request for anything else is
 * ignored server-side, so a hand-edited URL cannot print medical, dietary,
 * insurance or birth-date answers.
 */

export const checkInBookStatuses = ["SUBMITTED", "CONFIRMED", "WAITLISTED", "CANCELLED"] as const;
export type CheckInBookStatus = typeof checkInBookStatuses[number];
export const defaultCheckInBookStatuses: readonly CheckInBookStatus[] = ["SUBMITTED", "CONFIRMED"];

/** Status filter from a query string; unknown values are dropped and an empty result falls back to the default. */
export function parseCheckInBookStatuses(raw: string | string[] | undefined): CheckInBookStatus[] {
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap((value) => value.split(","));
  const picked = checkInBookStatuses.filter((status) => values.includes(status));
  return picked.length > 0 ? picked : [...defaultCheckInBookStatuses];
}

/* ---------------------------------------------------------------------- */
/* Extra column: which answers may be chosen                              */
/* ---------------------------------------------------------------------- */

// Choice, checkbox and number answers only: free text can hold anything.
const extraColumnFieldTypes = new Set(["SELECT", "RADIO", "MULTISELECT", "CHECKBOX", "NUMBER"]);

// Already shown in the book, so not offered as the extra column.
const displayedKeys = new Set([
  "first_name", "last_name", "full_name", "name", "attendee_name", "guest_name",
  "attendee_type", "attendee_age", "age",
]);

// Never offered, and a field controlled by one of these is never offered either.
const blockedKeys = new Set([
  "gender", "registration_fee", "birth_date", "birthdate", "date_of_birth", "dob", "dietary_needs",
]);

// The shared stems plus check-in-only extras. The Age column already shows age,
// so an age-based field adds nothing.
const checkInSensitivePattern = sensitiveFieldPattern([
  "meal", "food", "kosher", "halal", "\\bsex\\b", "gender", "\\bminor", "under\\s*18", "\\bage\\b",
]);

function isBlockedByItself(field: RegistrationFormField, sectionTitle = "") {
  // The staff "Sensitive" flag (#743), explicit or defaulted for health-type fields, also rules a field out.
  return blockedKeys.has(field.key) || isSensitiveField(field, checkInSensitivePattern) || isFieldSensitive(field, { sectionTitle });
}

/**
 * Whether a field may be the extra column. A field is also ruled out when
 * anything up its `conditional` / `optionalWhen` controller chain is sensitive
 * or blocked, since showing the answer would reveal the answer it depends on.
 */
export function isCheckInBookExtraField(
  field: RegistrationFormField,
  allFields: readonly RegistrationFormField[] = [],
  options: { scopes?: readonly string[]; types?: ReadonlySet<string>; sectionTitleOf?: (field: RegistrationFormField) => string } = {},
) {
  const scopes = options.scopes ?? ["ATTENDEE"];
  if (!scopes.includes(field.scope) || !(options.types ?? extraColumnFieldTypes).has(field.type)) return false;
  const titleOf = options.sectionTitleOf ?? (() => "");
  if (displayedKeys.has(field.key) || isBlockedByItself(field, titleOf(field))) return false;
  return !isLinkedToBlockedField(field, allFields, (other) => isBlockedByItself(other, titleOf(other)));
}

export type CheckInBookExtraOption = { key: string; label: string };

export type CheckInBookRegistration = {
  id: string;
  confirmationCode: string;
  accountHolder: { firstName: string; lastName: string; email: string; phone: string };
  attendees: Array<{
    id: string;
    firstName: string;
    lastName: string;
    attendeeType: string;
    responses: Record<string, unknown>;
  }>;
  publicSubmission: { definition: unknown } | null;
  location?: { id: string; name: string } | null;
};

function eligibleExtraFields(registrations: CheckInBookRegistration[]) {
  const fields = new Map<string, RegistrationFormField>();
  const banned = new Set<string>();
  const seenDefinitions = new Set<unknown>();
  for (const registration of registrations) {
    const raw = registration.publicSubmission?.definition;
    if (!raw || seenDefinitions.has(raw)) continue;
    seenDefinitions.add(raw);
    const parsed = registrationFormDefinitionSchema.safeParse(raw);
    if (!parsed.success) continue;
    const allFields = parsed.data.sections.flatMap((section) => section.fields);
    const sectionTitleOf = sectionTitleLookup(parsed.data.sections);
    for (const field of allFields) {
      // A key that is ineligible in any form version stays out for all of them.
      if (!isCheckInBookExtraField(field, allFields, { sectionTitleOf })) {
        banned.add(field.key);
        continue;
      }
      if (!fields.has(field.key)) fields.set(field.key, field);
    }
  }
  for (const key of banned) fields.delete(key);
  return fields;
}

/** The attendee answers staff may pick for the extra column, sorted by label. */
export function checkInBookExtraOptions(registrations: CheckInBookRegistration[]): CheckInBookExtraOption[] {
  return [...eligibleExtraFields(registrations).values()]
    .map((field) => ({ key: field.key, label: field.label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "";
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(", ");
  return "";
}

function extraValue(field: RegistrationFormField | undefined, responses: Record<string, unknown>) {
  if (!field) return "";
  const raw = responses[field.key];
  const labels = field.optionLabels ?? {};
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => textOf(typeof entry === "string" ? labels[entry] ?? entry : entry))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof raw === "string") return (labels[raw] ?? raw).trim();
  return textOf(raw);
}

/** Each registration's age answer key, read from its own form definition (e.g. `guest_age`). */
function ageKeysByRegistration(registrations: CheckInBookRegistration[]) {
  const keys = new Map<string, string>();
  for (const registration of registrations) {
    const parsed = registrationFormDefinitionSchema.safeParse(registration.publicSubmission?.definition);
    if (!parsed.success) continue;
    // The club form's age key first, then Camp Meeting's `guest_age`, or a number field labelled exactly "Age" or "Guest age".
    const key = attendeeAgeKey(parsed.data)
      ?? parsed.data.sections.flatMap((section) => section.fields)
        .find((field) => field.scope === "ATTENDEE" && field.type === "NUMBER" && (field.key === "guest_age" || /^(?:guest\s+)?age$/i.test(field.label.trim())))?.key;
    if (key) keys.set(registration.id, key);
  }
  return keys;
}

function ageOf(responses: Record<string, unknown>, definitionKey?: string): number | null {
  for (const key of [definitionKey, "attendee_age", "age"]) {
    if (!key) continue;
    const value = responses[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/* ---------------------------------------------------------------------- */
/* The book                                                               */
/* ---------------------------------------------------------------------- */

export type CheckInBookRow = {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  /** The roster role (Pathfinder, TLT, Staff, Child), or the attendee type on non-club events. */
  role: string;
  age: number | null;
  extra: string;
};

export type CheckInBookPage = {
  id: string;
  kind: "CLUB" | "REGISTRATION";
  title: string;
  /** Church, director, phone and email for a club; registrant name and phone for a registration group. */
  church: string;
  /** The event location this club or registration is at (#413); null when the event has none. */
  locationName: string | null;
  contactName: string;
  phone: string;
  email: string;
  /** Null on registration groups: there is no camping line. */
  camping: { kitchen: string; tents: string } | null;
  confirmationCode: string;
  attendees: CheckInBookRow[];
};

export type CheckInBook = {
  event: { name: string; startsOn: string; endsOn: string; timezone: string };
  mode: "CLUB" | "REGISTRATION";
  /** The selected location's name, or "All locations"; null when the event has no locations (#413). */
  locationLabel: string | null;
  extraColumn: CheckInBookExtraOption | null;
  cover: { pageCount: number; peopleCount: number };
  pages: CheckInBookPage[];
};

export type BuildCheckInBookInput = {
  event: CheckInBook["event"];
  mode: "CLUB" | "REGISTRATION";
  clubs: ClubEventRecord[];
  registrations: CheckInBookRegistration[];
  extraFieldKey?: string | null;
  locationLabel?: string | null;
};

const dash = "—";

function byName(left: { lastName: string; firstName: string }, right: { lastName: string; firstName: string }) {
  return left.lastName.localeCompare(right.lastName) || left.firstName.localeCompare(right.firstName);
}

export function buildCheckInBook(input: BuildCheckInBookInput): CheckInBook {
  const eligible = eligibleExtraFields(input.registrations);
  // A key that is not an eligible attendee field (unknown, or sensitive) is ignored.
  const extraField = input.extraFieldKey ? eligible.get(input.extraFieldKey) : undefined;
  const ageKeys = ageKeysByRegistration(input.registrations);
  const registrationsById = new Map(input.registrations.map((registration) => [registration.id, registration]));

  const pages: CheckInBookPage[] = [];
  if (input.mode === "CLUB") {
    for (const club of input.clubs) {
      const registration = registrationsById.get(club.registrationId);
      const responsesById = new Map((registration?.attendees ?? []).map((attendee) => [attendee.id, attendee.responses]));
      pages.push({
        id: club.organizationId,
        kind: "CLUB",
        title: club.organizationName,
        church: club.sponsoringChurch ?? "",
        locationName: club.locationName ?? null,
        contactName: club.directorName,
        phone: club.phone,
        email: club.email,
        camping: { kitchen: club.camping.kitchenCanopy || dash, tents: club.camping.tents || dash },
        confirmationCode: club.confirmationCode,
        attendees: [...club.attendees].sort(byName).map((attendee) => ({
          id: attendee.id,
          firstName: attendee.firstName,
          lastName: attendee.lastName,
          name: `${attendee.firstName} ${attendee.lastName}`.trim(),
          role: attendee.role ?? "",
          age: attendee.ageOnEventDate,
          extra: extraValue(extraField, responsesById.get(attendee.id) ?? {}),
        })),
      });
    }
  } else {
    for (const registration of input.registrations) {
      const holder = registration.accountHolder;
      const holderName = `${holder.firstName} ${holder.lastName}`.trim();
      pages.push({
        id: registration.id,
        kind: "REGISTRATION",
        title: holderName || registration.confirmationCode,
        church: "",
        locationName: registration.location?.name ?? null,
        contactName: holderName,
        phone: holder.phone,
        // The registrant's email is deliberately not carried into the book.
        email: "",
        camping: null,
        confirmationCode: registration.confirmationCode,
        attendees: [...registration.attendees].sort(byName).map((attendee) => {
          const role = textOf(attendee.responses.attendee_type) || attendee.attendeeType;
          return {
            id: attendee.id,
            firstName: attendee.firstName,
            lastName: attendee.lastName,
            name: `${attendee.firstName} ${attendee.lastName}`.trim(),
            role,
            age: ageOf(attendee.responses, ageKeys.get(registration.id)),
            extra: extraValue(extraField, attendee.responses),
          };
        }),
      });
    }
  }

  pages.sort((left, right) => (
    left.title.localeCompare(right.title) || left.confirmationCode.localeCompare(right.confirmationCode)
  ));

  return {
    event: input.event,
    mode: input.mode,
    locationLabel: input.locationLabel ?? null,
    extraColumn: extraField ? { key: extraField.key, label: extraField.label } : null,
    cover: {
      pageCount: pages.length,
      peopleCount: pages.reduce((total, page) => total + page.attendees.length, 0),
    },
    pages,
  };
}

export function checkInBookCsv(book: CheckInBook) {
  const extraHeader = book.extraColumn?.label ?? "Extra";
  const isClub = book.mode === "CLUB";
  // Registration groups carry the registrant's name and phone only: no email, church or camping.
  const table: Array<Array<string | number>> = [isClub
    ? ["Club", "Church", "Director", "Phone", "Email", "Kitchen", "Tents", "Check In", "Attendee", "Role", "Age", extraHeader]
    : ["Registrant", "Phone", "Check In", "Attendee", "Role", "Age", extraHeader]];
  const locations: Array<string | null> = [];
  for (const page of book.pages) {
    for (const attendee of page.attendees) {
      const person = [attendee.name, attendee.role, attendee.age ?? "", attendee.extra];
      table.push(isClub
        ? [page.title, page.church, page.contactName, page.phone, page.email, page.camping?.kitchen ?? "", page.camping?.tents ?? "", "", ...person]
        : [page.title, page.phone, "", ...person]);
      locations.push(page.locationName);
    }
  }
  // A Location column only when the event has locations (#413), right after the club or registrant name.
  return toCsv(withLocationColumn(table, locations, 1));
}
