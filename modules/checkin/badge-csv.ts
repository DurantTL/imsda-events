import {
  registrationFormDefinitionSchema,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { buildBadgeLabels } from "@/modules/checkin/badge-labels";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import { sectionTitleLookup } from "@/modules/forms/field-flags";
import { isCheckInBookExtraField } from "@/modules/reporting/check-in-book";

/**
 * CSV for a mail merge in Avery Design & Print. The header matches the
 * director's sample template exactly. ID is the registration confirmation
 * code; attendee pass tokens are credentials and never leave through this file.
 *
 * Position is an explicit staff choice, never guessed: only a plain text or
 * single-choice field that is not sensitive, and not controlled (directly or
 * through a chain) by a sensitive field, can be chosen.
 *
 * Attendee type is the last column so existing Avery templates keep mapping
 * ID, Name and Position. It carries the same label the badge prints. When the
 * page's "Show attendee type" setting is off the column stays in the file (so
 * the header never changes under a saved Avery merge) with every value empty.
 */
export const badgeCsvHeader = ["ID", "Name", "Position", "Attendee type"] as const;

const positionFieldTypes = new Set(["TEXT", "SELECT", "RADIO"]);
const positionScopes = ["ATTENDEE", "REGISTRATION"] as const;

export type BadgePositionOption = { key: string; label: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseFields(definition: unknown) {
  const parsed = registrationFormDefinitionSchema.safeParse(definition);
  if (!parsed.success) return null;
  return {
    all: parsed.data.sections.flatMap((section) => section.fields),
    sectionTitleOf: sectionTitleLookup(parsed.data.sections),
  };
}

function isEligible(field: RegistrationFormField, parsed: NonNullable<ReturnType<typeof parseFields>>) {
  return isCheckInBookExtraField(field, parsed.all, {
    scopes: positionScopes,
    types: positionFieldTypes,
    sectionTitleOf: parsed.sectionTitleOf,
  });
}

function eligibleFields(definition: unknown): RegistrationFormField[] {
  const parsed = parseFields(definition);
  return parsed ? parsed.all.filter((field) => isEligible(field, parsed)) : [];
}

/** Keys that are ineligible in ANY form version present (#743): a key stays out for all of them. */
function bannedKeys(registrations: RegistrationRecord[]) {
  const banned = new Set<string>();
  const seen = new Set<unknown>();
  for (const registration of registrations) {
    const raw = registration.publicSubmission?.definition;
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const parsed = parseFields(raw);
    if (!parsed) continue;
    for (const field of parsed.all) if (!isEligible(field, parsed)) banned.add(field.key);
  }
  return banned;
}

/** Fields staff may choose as Position, across the event's registration forms. */
export function badgePositionOptions(
  registrations: RegistrationRecord[],
): BadgePositionOption[] {
  const found = new Map<string, { label: string; forms: Set<string> }>();
  const banned = bannedKeys(registrations);
  for (const registration of registrations) {
    const formName = registration.publicSubmission?.formName ?? "";
    for (const field of eligibleFields(registration.publicSubmission?.definition)) {
      if (banned.has(field.key)) continue;
      const entry = found.get(field.key) ?? { label: field.label, forms: new Set<string>() };
      if (formName) entry.forms.add(formName);
      found.set(field.key, entry);
    }
  }
  return [...found.entries()]
    .map(([key, { label, forms }]) => ({
      key,
      // The same question key in more than one form: say which forms.
      label: forms.size > 1 ? `${label} (${[...forms].sort().join(", ")})` : label,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** The chosen key when it is eligible, otherwise null (blank Position). */
export function eligiblePositionField(
  registrations: RegistrationRecord[],
  key: string | undefined,
) {
  return key && badgePositionOptions(registrations).some((option) => option.key === key)
    ? key
    : null;
}

export function buildBadgeCsvRows(
  registrations: RegistrationRecord[],
  positionField: string | null = null,
  showAttendeeType = true,
): string[][] {
  const positionByAttendee = new Map<string, string>();
  if (positionField && !bannedKeys(registrations).has(positionField)) {
    for (const registration of registrations) {
      // Eligibility is checked against this registration's own form version.
      const field = eligibleFields(registration.publicSubmission?.definition)
        .find((candidate) => candidate.key === positionField);
      if (!field) continue;
      const registrationAnswer = answerText(
        field,
        record(registration.publicSubmission?.responses)[positionField],
      );
      for (const attendee of registration.attendees) {
        positionByAttendee.set(
          attendee.id,
          field.scope === "REGISTRATION"
            ? registrationAnswer
            : answerText(field, record(attendee.responses)[positionField]),
        );
      }
    }
  }
  return [
    [...badgeCsvHeader],
    ...buildBadgeLabels(registrations).map((label) => [
      label.confirmationCode,
      `${label.firstName} ${label.lastName}`.trim(),
      positionByAttendee.get(label.attendeeId) ?? "",
      showAttendeeType ? label.attendeeTypeLabel : "",
    ]),
  ];
}

/** The text as staff saw it: a choice exports its option label, not the stored value. */
function answerText(field: RegistrationFormField, value: unknown) {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  return field.type === "SELECT" || field.type === "RADIO"
    ? (field.optionLabels?.[raw] ?? raw).trim()
    : raw;
}

export function badgeCsvFilename(eventSlug: string) {
  const slug = eventSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "event"}-avery-94237.csv`;
}
