/**
 * What removing one attendee from a roster form should do (#569, F-13).
 * Pure so the confirm-before-discard rules are testable without a browser.
 */
export type AttendeeRemovalPlan = "blocked" | "remove" | "confirm";

export function planAttendeeRemoval<T extends { clientId: string }>(
  attendees: readonly T[],
  clientId: string,
  minAttendees: number,
  hasAnswers: (attendee: T) => boolean,
): AttendeeRemovalPlan {
  const target = attendees.find((attendee) => attendee.clientId === clientId);
  if (!target || attendees.length <= minAttendees) return "blocked";
  return hasAnswers(target) ? "confirm" : "remove";
}

/** The roster without the attendee, matched by id so a reorder can't hit the wrong one. */
export function withoutAttendee<T extends { clientId: string }>(attendees: readonly T[], clientId: string): T[] {
  return attendees.filter((attendee) => attendee.clientId !== clientId);
}
