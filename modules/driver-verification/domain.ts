/**
 * Driver verification rules (#491, reworked by #544). Driver clearance comes
 * from the background-check list, not a staff review: see `clearance.ts` for
 * how it is derived, and `repository.ts` for the staff exceptions queue, the
 * club's labels, and staff overrides. This file keeps what is left of #491:
 *
 * - A "Willing to drive" checkbox on a staff or adult roster profile
 *   (`ClubRosterMember.willingToDrive`). Checking it never grants clearance;
 *   it only makes the person's clearance visible (to the club as a label, to
 *   staff when it is an exception).
 * - Self-nomination: a staff reviewer can't override their own record.
 *
 * Kept pure: no database access, no server-only import, so every rule here
 * is unit-testable without a database.
 */

/** Only staff and adult roster rows can be marked willing to drive (#491). */
export type DriverEligibleAttendeeType = "STAFF" | "ADULT";

const DRIVER_ELIGIBLE_TYPES = new Set<string>(["STAFF", "ADULT"]);

export function canBeWillingDriver(attendeeType: string): attendeeType is DriverEligibleAttendeeType {
  return DRIVER_ELIGIBLE_TYPES.has(attendeeType);
}

/**
 * A roster edit that would leave `willingToDrive` true on a row that isn't
 * staff or an adult (a youth moved to "willing", or a youth row created with
 * it already set) is rejected rather than silently dropped, so nothing about
 * a minor's profile can carry this flag by mistake.
 */
export function willingToDriveAllowed(attendeeType: string, willingToDrive: boolean | undefined) {
  return !willingToDrive || canBeWillingDriver(attendeeType);
}

/**
 * Whether overriding this person would be self-nomination: the actor
 * overriding their own record. Checked regardless of role. `reviewerPersonId`
 * is null when the actor has no `Person` record linked at all, which can
 * never equal a real `targetPersonId` and so is never self-review.
 */
export function isSelfNomination(reviewerPersonId: string | null, targetPersonId: string) {
  return reviewerPersonId !== null && reviewerPersonId === targetPersonId;
}
