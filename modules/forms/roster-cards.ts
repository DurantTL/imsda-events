import {
  isFieldRequired,
  isFieldVisible,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";

/**
 * Compact attendee cards (#483): a card collapses to a one-line summary once
 * every visible, required attendee-scope field has an answer, and expands
 * back out on request. Pure so the component and its tests agree on when a
 * card reads as "done".
 */

function hasAnswer(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/** Every required, visible ATTENDEE-scope field for this person has an answer. */
export function isAttendeeCardComplete(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  attendeeResponses: Record<string, unknown>,
): boolean {
  const merged = { ...registrationResponses, ...attendeeResponses };
  return definition.sections
    .flatMap((section) => section.fields)
    .filter((field) => field.scope === "ATTENDEE")
    .every((field) => (
      !isFieldVisible(field, merged)
      || !isFieldRequired(field, merged)
      || hasAnswer(merged[field.key])
    ));
}

/** The role field's currently chosen option, in its display label if one is
 * configured, or null when there's no role field or no answer yet. */
export function attendeeRoleLabel(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  attendeeResponses: Record<string, unknown>,
): string | null {
  const merged = { ...registrationResponses, ...attendeeResponses };
  const field = definition.sections
    .flatMap((section) => section.fields)
    .find((candidate) => (
      candidate.scope === "ATTENDEE"
      && candidate.key === "attendee_type"
      && ["RADIO", "SELECT"].includes(candidate.type)
    ));
  if (!field) return null;
  const value = merged[field.key];
  if (typeof value !== "string" || !value) return null;
  return field.optionLabels?.[value] ?? value;
}

/**
 * Whether a card should start collapsed: cards carried over from the roster
 * (a club attendee, never a manually added or CSV-imported one) start
 * collapsed (#483); every other new card starts open so the person filling
 * it in can see the fields right away.
 */
export function startsCollapsed(isRosterCarried: boolean): boolean {
  return isRosterCarried;
}
