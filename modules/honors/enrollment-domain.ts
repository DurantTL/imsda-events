/**
 * Honors Weekend class selection (#359). Pure rules the server enforces
 * inside the enrollment transaction; the director's screen only mirrors them.
 */

export type SelectableOffering = {
  id: string;
  honorName: string;
  span: "SINGLE_SESSION" | "ALL_SESSIONS";
  sessionId: string | null;
  minimumAge: number | null;
  isActive: boolean;
};

export type SelectingAttendee = {
  ageOnEventDate: number | null;
};

/** Only youth use a class seat or count toward a club's limit. Staff and adults join freely. */
export function consumesClassSeat(attendeeType: string | null | undefined) {
  return attendeeType !== "STAFF" && attendeeType !== "ADULT";
}

/**
 * Why this set of classes isn't allowed for this person, or null. At most one
 * class per session; an all-sessions class must be the only one; the person
 * must be old enough on the event date. `alreadyEnrolled` lets someone keep a
 * class staff have since deactivated, but never join one.
 */
export function selectionProblem(
  attendee: SelectingAttendee,
  offeringIds: readonly string[],
  offerings: ReadonlyMap<string, SelectableOffering>,
  alreadyEnrolled: ReadonlySet<string> = new Set(),
) {
  if (new Set(offeringIds).size !== offeringIds.length) return "The same class was chosen twice.";
  const chosen: SelectableOffering[] = [];
  for (const id of offeringIds) {
    const offering = offerings.get(id);
    if (!offering) return "One of the chosen classes isn't offered at this site.";
    if (!offering.isActive && !alreadyEnrolled.has(id)) return `${offering.honorName} is no longer offered.`;
    chosen.push(offering);
  }
  const allSessions = chosen.filter((offering) => offering.span === "ALL_SESSIONS");
  if (allSessions.length > 0 && chosen.length > 1) {
    return `${allSessions[0].honorName} fills every session, so it has to be the only class.`;
  }
  const sessions = new Set<string>();
  for (const offering of chosen) {
    if (offering.span !== "SINGLE_SESSION" || !offering.sessionId) continue;
    if (sessions.has(offering.sessionId)) return "Choose at most one class per session.";
    sessions.add(offering.sessionId);
  }
  for (const offering of chosen) {
    if (offering.minimumAge === null || alreadyEnrolled.has(offering.id)) continue;
    if (attendee.ageOnEventDate === null) return `${offering.honorName} has a minimum age, and this person's age isn't on the roster.`;
    if (attendee.ageOnEventDate < offering.minimumAge) {
      return `${offering.honorName} is for ages ${offering.minimumAge} and up.`;
    }
  }
  return null;
}
