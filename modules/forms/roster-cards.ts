import {
  isFieldRequired,
  isFieldVisible,
  type RegistrationFormDefinition,
  type RegistrationFormField,
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

export type CardCollapseInput = {
  /** Carried over from the club roster (a club attendee, never a manually
   * added or CSV-imported one). */
  carriedFromRoster: boolean;
  /** Every required, visible attendee field is answered. */
  complete: boolean;
  /** Carried-over values that didn't match a form option. */
  mismatchCount: number;
  /** A validation issue points at a control inside this card. */
  targetedByIssue: boolean;
};

/**
 * Whether a card should start collapsed (#483). Only a card carried over
 * from the roster starts collapsed, and only when there's nothing in it to
 * act on: a card with a "Couldn't match…" prompt, a missing required answer,
 * or a validation issue starts open so that prompt or control is visible.
 */
export function startsCollapsed({ carriedFromRoster, complete, mismatchCount, targetedByIssue }: CardCollapseInput): boolean {
  return carriedFromRoster && complete && mismatchCount === 0 && !targetedByIssue;
}

/**
 * The roster position a validation issue points at, or null for a
 * registration-level issue. An ATTENDEE-scope issue with no position is
 * shown on the first card (matching where the error summary links to).
 */
export function issueAttendeeIndex(
  issue: { path?: string; attendeeIndex?: number | null },
  fieldScope: RegistrationFormField["scope"] | null,
): number | null {
  if (typeof issue.attendeeIndex === "number") return issue.attendeeIndex;
  const pathIndex = issue.path?.match(/^attendees\.(\d+)\./)?.[1];
  if (pathIndex !== undefined) return Number(pathIndex);
  return fieldScope === "ATTENDEE" ? 0 : null;
}

/**
 * Error-summary wording for a multi-attendee form (#738): a missing-field
 * message says whose field it is ("Guest Two — T-shirt size is required.").
 * `names` are the attendees' display names in roster order; a name shared by
 * two people gets its roster position so the links stay distinguishable.
 * Registration-level issues (null index) and single-attendee forms keep the
 * plain message.
 */
export function namedIssueMessage(
  message: string,
  attendeeIndex: number | null,
  names: readonly string[],
  positionLabel: string,
): string {
  if (attendeeIndex === null || names.length < 2) return message;
  const name = names[attendeeIndex];
  if (!name) return message;
  // A server message that already says who ("Attendee 2: ...") is not named twice.
  const escaped = positionLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b(attendee|${escaped})\\s+\\d+\\b`, "i").test(message) || message.includes(name)) return message;
  const shared = names.filter((candidate) => candidate === name).length > 1;
  const who = shared ? `${name} (${positionLabel} ${attendeeIndex + 1})` : name;
  return `${who} — ${message}`;
}
