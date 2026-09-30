import {
  registrationFormDefinitionSchema,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { buildBadgeLabels } from "@/modules/checkin/badge-labels";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import { isCheckInBookExtraField } from "@/modules/reporting/check-in-book";

/**
 * CSV for a mail merge in Avery Design & Print. The header matches the
 * director's sample template exactly. ID is the registration confirmation
 * code; attendee pass tokens are credentials and never leave through this file.
 *
 * Position is an explicit staff choice, never guessed: only a plain text or
 * single-choice field that is not sensitive, and not controlled (directly or
 * through a chain) by a sensitive field, can be chosen.
 */
export const badgeCsvHeader = ["ID", "Name", "Position"] as const;

const positionFieldTypes = new Set(["TEXT", "SELECT", "RADIO"]);
const positionScopes = ["ATTENDEE", "REGISTRATION"] as const;

export type BadgePositionOption = { key: string; label: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function eligibleFields(definition: unknown): RegistrationFormField[] {
  const parsed = registrationFormDefinitionSchema.safeParse(definition);
  if (!parsed.success) return [];
  const all = parsed.data.sections.flatMap((section) => section.fields);
  return all.filter((field) => isCheckInBookExtraField(field, all, {
    scopes: positionScopes,
    types: positionFieldTypes,
  }));
}

/** Fields staff may choose as Position, across the event's registration forms. */
export function badgePositionOptions(
  registrations: RegistrationRecord[],
): BadgePositionOption[] {
  const options = new Map<string, BadgePositionOption>();
  for (const registration of registrations) {
    for (const field of eligibleFields(registration.publicSubmission?.definition)) {
      if (!options.has(field.key)) options.set(field.key, { key: field.key, label: field.label });
    }
  }
  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
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
): string[][] {
  const positionByAttendee = new Map<string, string>();
  if (positionField) {
    for (const registration of registrations) {
      // Eligibility is checked against this registration's own form version.
      const field = eligibleFields(registration.publicSubmission?.definition)
        .find((candidate) => candidate.key === positionField);
      if (!field) continue;
      const registrationAnswer = answerText(
        record(registration.publicSubmission?.responses)[positionField],
      );
      for (const attendee of registration.attendees) {
        positionByAttendee.set(
          attendee.id,
          field.scope === "REGISTRATION"
            ? registrationAnswer
            : answerText(record(attendee.responses)[positionField]),
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
    ]),
  ];
}

function answerText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function badgeCsvFilename(eventSlug: string) {
  const slug = eventSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "event"}-avery-94237.csv`;
}
