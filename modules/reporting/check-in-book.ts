import {
  registrationFormDefinitionSchema,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import {
  roleAbbreviation,
  type ClubEventRecord,
} from "@/modules/reporting/club-event-reports";
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

const extraColumnFieldTypes = new Set(["TEXT", "SELECT", "RADIO", "MULTISELECT", "CHECKBOX", "NUMBER"]);

// Already shown in the book, or never printable: identity, age, fees.
const excludedExtraKeys = new Set([
  "first_name", "last_name", "full_name", "name", "attendee_name", "guest_name",
  "attendee_type", "attendee_age", "age", "gender", "registration_fee",
  "birth_date", "birthdate", "date_of_birth", "dob", "dietary_needs",
]);

const sensitiveExtraPattern =
  /\b(?:medical|medication|medicine|health|allerg\w*|diet\w*|food|meal|accessib\w*|disabil\w*|special\s*needs?|emergency|insurance|policy|birth\w*|dob|guardian|minor|injur\w*|diagnos\w*|condition|gender|sex|age|ssn|social\s*security)\b/i;

export function isCheckInBookExtraField(field: RegistrationFormField) {
  if (field.scope !== "ATTENDEE" || !extraColumnFieldTypes.has(field.type)) return false;
  if (excludedExtraKeys.has(field.key)) return false;
  return !sensitiveExtraPattern.test(`${field.key.replaceAll("_", " ")} ${field.label}`);
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
};

function eligibleExtraFields(registrations: CheckInBookRegistration[]) {
  const fields = new Map<string, RegistrationFormField>();
  for (const registration of registrations) {
    if (!registration.publicSubmission) continue;
    const parsed = registrationFormDefinitionSchema.safeParse(registration.publicSubmission.definition);
    if (!parsed.success) continue;
    for (const section of parsed.data.sections) {
      for (const field of section.fields) {
        if (isCheckInBookExtraField(field) && !fields.has(field.key)) fields.set(field.key, field);
      }
    }
  }
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

function ageOf(responses: Record<string, unknown>): number | null {
  for (const key of ["attendee_age", "age"]) {
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
  /** Club roster abbreviation (PF, TLT, Stf, Ch), or the attendee type on non-club events. */
  role: string;
  /** Full role, used by the CSV. */
  roleLabel: string;
  age: number | null;
  extra: string;
};

export type CheckInBookPage = {
  id: string;
  kind: "CLUB" | "REGISTRATION";
  title: string;
  /** Church, director, phone and email for a club; registrant name and phone for a registration group. */
  church: string;
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
};

const dash = "—";

function byName(left: { lastName: string; firstName: string }, right: { lastName: string; firstName: string }) {
  return left.lastName.localeCompare(right.lastName) || left.firstName.localeCompare(right.firstName);
}

export function buildCheckInBook(input: BuildCheckInBookInput): CheckInBook {
  const eligible = eligibleExtraFields(input.registrations);
  // A key that is not an eligible attendee field (unknown, or sensitive) is ignored.
  const extraField = input.extraFieldKey ? eligible.get(input.extraFieldKey) : undefined;
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
          role: roleAbbreviation(attendee.role),
          roleLabel: attendee.role ?? "",
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
        contactName: holderName,
        phone: holder.phone,
        email: holder.email,
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
            roleLabel: role,
            age: ageOf(attendee.responses),
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
    extraColumn: extraField ? { key: extraField.key, label: extraField.label } : null,
    cover: {
      pageCount: pages.length,
      peopleCount: pages.reduce((total, page) => total + page.attendees.length, 0),
    },
    pages,
  };
}

export function checkInBookCsv(book: CheckInBook) {
  const table: Array<Array<string | number>> = [[
    book.mode === "CLUB" ? "Club" : "Registration",
    "Church",
    book.mode === "CLUB" ? "Director" : "Registrant",
    "Phone",
    "Email",
    "Kitchen",
    "Tents",
    "Check In",
    "Attendee",
    "Role",
    "Age",
    book.extraColumn?.label ?? "Extra",
  ]];
  for (const page of book.pages) {
    for (const attendee of page.attendees) {
      table.push([
        page.title,
        page.church,
        page.contactName,
        page.phone,
        page.email,
        page.camping?.kitchen ?? "",
        page.camping?.tents ?? "",
        "",
        attendee.name,
        attendee.roleLabel,
        attendee.age ?? "",
        attendee.extra,
      ]);
    }
  }
  return toCsv(table);
}
