import { buildBadgeLabels } from "@/modules/checkin/badge-labels";
import type { RegistrationRecord } from "@/modules/registrations/repository";

/**
 * CSV for a mail merge in Avery Design & Print (QR code from ID). The header
 * matches the director's sample template exactly. ID is the registration
 * confirmation code, which the check-in lookup accepts; attendee pass tokens
 * are credentials and never leave through this file.
 */
export const badgeCsvHeader = ["ID", "Name", "Position"] as const;

const positionPattern = /\b(position|role|title|ministry)\b/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function words(value: string) {
  return value.replace(/[_\-.]+/g, " ");
}

function answerText(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join("; ");
  }
  return "";
}

/** Keys of attendee-level form fields whose key or label reads as a position. */
export function positionFieldKeys(definition: unknown) {
  const keys: string[] = [];
  const sections = record(definition).sections;
  if (!Array.isArray(sections)) return keys;
  for (const section of sections) {
    const fields = record(section).fields;
    if (!Array.isArray(fields)) continue;
    for (const raw of fields) {
      const field = record(raw);
      if (typeof field.key !== "string" || field.scope !== "ATTENDEE") continue;
      const label = typeof field.label === "string" ? field.label : "";
      if (positionPattern.test(words(field.key)) || positionPattern.test(label)) {
        keys.push(field.key);
      }
    }
  }
  return keys;
}

/**
 * The attendee's answer to a position-like field, or "" when the form has
 * none. The attendee type is deliberately not used as a fallback.
 */
export function badgePosition(
  responses: unknown,
  definition: unknown,
) {
  const answers = record(responses);
  const candidates = positionFieldKeys(definition);
  // Without a readable definition, fall back to the answer keys themselves,
  // the way the shirt size is read straight from its known key.
  const keys = candidates.length > 0
    ? candidates
    : Object.keys(answers).filter((key) => positionPattern.test(words(key)));
  for (const key of keys) {
    const text = answerText(answers[key]);
    if (text) return text;
  }
  return "";
}

export function buildBadgeCsvRows(
  registrations: RegistrationRecord[],
): string[][] {
  const positionByAttendee = new Map<string, string>();
  for (const registration of registrations) {
    const definition = registration.publicSubmission?.definition;
    for (const attendee of registration.attendees) {
      positionByAttendee.set(
        attendee.id,
        badgePosition(attendee.responses, definition),
      );
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

export function badgeCsvFilename(eventSlug: string) {
  const slug = eventSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "event"}-avery-94237.csv`;
}
