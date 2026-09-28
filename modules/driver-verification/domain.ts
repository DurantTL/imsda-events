/**
 * Driver verification (Q1, #491). Background checks already cover driver
 * clearance (`modules/background-checks`: y/n/! plus an issue note such as
 * "can't drive") — this module adds only what's missing:
 *
 * - A "Willing to drive" checkbox on a staff or volunteer roster profile
 *   (`ClubRosterMember.willingToDrive`). Checking it never grants clearance
 *   by itself; it only puts the person in the verification queue below.
 * - A verification queue listing every willing driver together with their
 *   current background-check status and note, for a reviewer to work from.
 * - The reviewer's own decision (`DriverVerification`): confirmation that the
 *   license, insurance, and background-check clearance were checked
 *   elsewhere, plus an outcome (cleared to transport youth or not) and a
 *   note. Only the reviewer, the date, and the outcome are stored — never a
 *   license or insurance number or file.
 *
 * Kept pure: no database access, no server-only import, so every rule here
 * is unit-testable without a database.
 */

import type { BackgroundCheckState } from "@/modules/background-checks/domain";

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

export type DriverVerificationOutcome = {
  clearedToTransport: boolean;
  note: string;
  reviewedAt: string;
  reviewerName: string;
} | null;

export type DriverQueueRow = {
  personId: string;
  rosterMemberId: string;
  firstName: string;
  lastName: string;
  attendeeType: DriverEligibleAttendeeType;
  organizationId: string;
  organizationName: string;
  /** The background check compliance state and note already on file (#427/#388); never re-derived here. */
  backgroundCheck: { state: Exclude<BackgroundCheckState, never>; note: string | null };
  /** Null until a reviewer has recorded a decision; a later review replaces it, never stacks. */
  verification: DriverVerificationOutcome;
};

/**
 * Whether reviewing this person would be self-nomination: the actor
 * confirming their own license, insurance, and background check. Checked
 * regardless of role — a club director or a system administrator reviewing
 * their own roster row is still self-nomination. `reviewerPersonId` is null
 * when the actor has no `Person` record linked at all, which can never equal
 * a real `targetPersonId` and so is never self-review.
 */
export function isSelfNomination(reviewerPersonId: string | null, targetPersonId: string) {
  return reviewerPersonId !== null && reviewerPersonId === targetPersonId;
}
