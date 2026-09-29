/**
 * Automatic driver clearance (#544). A willing driver's clearance is worked
 * out from the stored background-check list (`modules/background-checks`, #527)
 * every time it is read, never stored: a new upload, or a person added later,
 * changes it with no staff action.
 *
 * The list's compliance column (y / ! / n) stays the primary overall status,
 * exactly as #527 reads it. The issues column only explains it (BGC,
 * Training, Non-Driver, optionally dated; see `modules/background-checks/issues`)
 * except for `Non-Driver`, which blocks driving by itself, and a `y` whose
 * dated `BGC` / `Training` item has passed, which is expired.
 *
 * Pure and client-safe: no database, no `node:` or server-only import. The
 * issues text is staff only (#427): nothing here for a club carries it,
 * only `clubDriverLabel` (in `modules/background-checks/display`).
 */

import {
  clubDriverLabel,
  driverReasonLabels,
  type DriverClearanceReason,
  type DriverClearanceStatus,
} from "@/modules/background-checks/display";
import { assessIssues, daysUntil } from "@/modules/background-checks/issues";

export { clubDriverLabel, driverReasonLabels };
export type { DriverClearanceReason, DriverClearanceStatus };

/** A dated item expiring within this many days is flagged to staff as a warning. */
export const DRIVER_EXPIRY_WARNING_DAYS = 30;

export type DriverClearance = {
  status: DriverClearanceStatus;
  reasons: DriverClearanceReason[];
  /** The soonest date still ahead (an issues item, or a Sterling check's expiry inside the warning window); otherwise null. */
  expiresOn: string | null;
  /** True for an `EXPIRING` driver whose date is within `DRIVER_EXPIRY_WARNING_DAYS`. Staff only. */
  warnStaff: boolean;
};

/** The stored check fields the rules read: a roster row's y/!/n mark, or a Sterling row's expiration. */
export type DriverCheckEvidence = {
  complianceStatus?: "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | null;
  expiresOn: string | null;
  issuesNote?: string | null;
};

function earlier(a: string | null, b: string | null) {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/**
 * Whether a willing driver is cleared, on `today` (a calendar date,
 * "YYYY-MM-DD" in the conference time zone).
 *
 * - Not cleared: `Non-Driver` (even beside `y` or `!`), `n`, a Sterling row
 *   past its expiration date, or a `y` with a dated `BGC` / `Training` item
 *   whose date has passed.
 * - Needs review: no matching check, `!`, a row with neither mark nor date,
 *   or a `y` whose issues text has anything else besides future-dated items
 *   (an undated item, or text that isn't recognised): the rare case, shown
 *   to staff with the `y` untouched.
 * - Expiring: cleared, with a future-dated `BGC` / `Training` item, or a
 *   Sterling row (no mark) whose own expiry is within the warning window.
 *   The soonest date is shown; staff are warned inside the window.
 * - Cleared: `y` (or an unexpired Sterling row) and nothing above.
 */
export function deriveDriverClearance(check: DriverCheckEvidence | null | undefined, today: string): DriverClearance {
  if (!check) return { status: "NEEDS_REVIEW", reasons: ["NO_RECORD"], expiresOn: null, warnStaff: false };

  const issues = assessIssues(check.issuesNote, today);
  const notCleared: DriverClearanceReason[] = [];
  const review: DriverClearanceReason[] = [];
  let isClear = false;
  let sterlingExpiry: string | null = null;

  if (issues.nonDriver) notCleared.push("NON_DRIVER");
  if (check.complianceStatus === "NOT_COMPLIANT") notCleared.push("CHECK_NOT_COMPLIANT");
  else if (check.complianceStatus === "FLAGGED") review.push("CHECK_FLAGGED");
  else if (check.complianceStatus === "CLEAR") isClear = true;
  else if (!check.expiresOn) review.push("NO_RECORD");
  else if (check.expiresOn < today) notCleared.push("CHECK_EXPIRED");
  else {
    isClear = true;
    // A Sterling row has no y/!/n mark, so its own expiry is the date; it counts as expiring only inside the window.
    if (daysUntil(today, check.expiresOn) <= DRIVER_EXPIRY_WARNING_DAYS) sterlingExpiry = check.expiresOn;
  }

  if (isClear && issues.pastDue.length > 0) notCleared.push("ISSUE_DATE_PASSED");
  if (notCleared.length > 0) return { status: "NOT_CLEARED", reasons: notCleared, expiresOn: issues.soonest, warnStaff: false };

  if (issues.unrecognised.length > 0) review.push("UNRECOGNISED_ISSUES");
  if (isClear && (issues.expired.length > 0 || issues.unrecognised.length > 0)) review.push("ISSUES_ON_CLEAR_CHECK");
  if (review.length > 0) return { status: "NEEDS_REVIEW", reasons: review, expiresOn: issues.soonest, warnStaff: false };

  const expiresOn = earlier(issues.soonest, sterlingExpiry);
  if (expiresOn) {
    return { status: "EXPIRING", reasons: [], expiresOn, warnStaff: daysUntil(today, expiresOn) <= DRIVER_EXPIRY_WARNING_DAYS };
  }
  return { status: "CLEARED", reasons: [], expiresOn: null, warnStaff: false };
}

/** Without an override, only exceptions need staff action: not cleared, needs review, or expiring inside the warning window. */
export function isDriverException(clearance: DriverClearance) {
  return clearance.status === "NOT_CLEARED"
    || clearance.status === "NEEDS_REVIEW"
    || (clearance.status === "EXPIRING" && clearance.warnStaff);
}

/**
 * An override is stale once a newer list has arrived: the check it was made
 * against has been replaced. A stale override is ignored and the derived
 * result stands. With no list upload to compare (nothing matched), it stands.
 */
export function overrideIsStale(reviewedAt: Date, listUploadedAt: Date | null | undefined) {
  return Boolean(listUploadedAt && listUploadedAt.getTime() > reviewedAt.getTime());
}

/**
 * Whether a person is in the staff queue. With no (current) override, they
 * are if they are an exception. With one, they are only if the override
 * disagrees with the list, so staff can see and undo it: cleared over a Not
 * cleared, or Not cleared over a clear or expiring driver. An override on a
 * Needs review driver is the staff decision that resolves it, and an
 * agreeing override needs no action.
 */
export function needsStaffAction(clearance: DriverClearance, override: { clearedToTransport: boolean } | null) {
  if (!override) return isDriverException(clearance);
  if (clearance.status === "NEEDS_REVIEW") return false;
  const derivedClear = clearance.status === "CLEARED" || clearance.status === "EXPIRING";
  return derivedClear !== override.clearedToTransport;
}
