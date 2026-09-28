/**
 * Automatic driver clearance (#544). A willing driver's clearance is worked
 * out from the stored background-check list (`modules/background-checks`, #527)
 * every time it is read, never stored: a new upload, or a person added later,
 * changes it with no staff action.
 *
 * The list's compliance column (y / ! / n) stays the primary overall status,
 * exactly as #527 reads it. The issues column only explains it (BGC,
 * Training, Non-Driver, optionally dated; see `modules/background-checks/issues`)
 * except for `Non-Driver`, which blocks driving by itself. The issues text
 * never changes a `y`; it puts that person in front of staff.
 *
 * Pure and client-safe: no database, no `node:` or server-only import. The
 * issues text is staff only (#427): nothing here for a club carries it,
 * only `clubDriverLabel`.
 */

import { assessIssues, daysUntil, formatIssueDate } from "@/modules/background-checks/issues";

/** A dated item expiring within this many days is flagged to staff as a warning. */
export const DRIVER_EXPIRY_WARNING_DAYS = 30;

export type DriverClearanceStatus = "CLEARED" | "EXPIRING" | "NOT_CLEARED" | "NEEDS_REVIEW";

/** Why a status is what it is. Staff only: these describe the note and the check. */
export type DriverClearanceReason =
  | "NON_DRIVER"
  | "CHECK_NOT_COMPLIANT"
  | "CHECK_EXPIRED"
  | "CHECK_FLAGGED"
  | "NO_RECORD"
  | "ISSUES_ON_CLEAR_CHECK"
  | "UNRECOGNISED_ISSUES";

export type DriverClearance = {
  status: DriverClearanceStatus;
  reasons: DriverClearanceReason[];
  /** The soonest `BGC` / `Training` date still ahead in the issues text, whatever the status; otherwise null. */
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

/**
 * Whether a willing driver is cleared, on `today` (a calendar date,
 * "YYYY-MM-DD" in the conference time zone).
 *
 * - Not cleared: `Non-Driver` (even beside `y` or `!`), or `n`, or a Sterling
 *   check past its expiration date.
 * - Needs review: no matching check, `!`, a check with neither mark nor date,
 *   or a `y` whose issues text has anything besides future-dated `BGC` /
 *   `Training` items (the rare case: shown to staff, the `y` untouched).
 * - Expiring: `y`, with only future-dated `BGC` / `Training` items. Cleared
 *   until the soonest date; staff are warned inside the warning window.
 * - Cleared: `y` (or an unexpired Sterling check) and blank issues.
 */
export function deriveDriverClearance(check: DriverCheckEvidence | null | undefined, today: string): DriverClearance {
  if (!check) return { status: "NEEDS_REVIEW", reasons: ["NO_RECORD"], expiresOn: null, warnStaff: false };

  const issues = assessIssues(check.issuesNote, today);
  const expiresOn = issues.soonest;
  const notCleared: DriverClearanceReason[] = [];
  const review: DriverClearanceReason[] = [];
  let isClear = false;

  if (issues.nonDriver) notCleared.push("NON_DRIVER");
  if (check.complianceStatus === "NOT_COMPLIANT") notCleared.push("CHECK_NOT_COMPLIANT");
  else if (check.complianceStatus === "FLAGGED") review.push("CHECK_FLAGGED");
  else if (check.complianceStatus === "CLEAR") isClear = true;
  else if (!check.expiresOn) review.push("NO_RECORD");
  else if (check.expiresOn < today) notCleared.push("CHECK_EXPIRED");
  else isClear = true;

  if (notCleared.length > 0) return { status: "NOT_CLEARED", reasons: notCleared, expiresOn, warnStaff: false };
  if (issues.unrecognised.length > 0) review.push("UNRECOGNISED_ISSUES");
  if (isClear && (issues.expired.length > 0 || issues.unrecognised.length > 0)) review.push("ISSUES_ON_CLEAR_CHECK");
  if (review.length > 0) return { status: "NEEDS_REVIEW", reasons: review, expiresOn, warnStaff: false };
  if (expiresOn) {
    return { status: "EXPIRING", reasons: [], expiresOn, warnStaff: daysUntil(today, expiresOn) <= DRIVER_EXPIRY_WARNING_DAYS };
  }
  return { status: "CLEARED", reasons: [], expiresOn: null, warnStaff: false };
}

/** Staff queue rule: only exceptions need action. Cleared drivers, and those expiring later than the warning window, do not. */
export function isDriverException(clearance: DriverClearance) {
  return clearance.status === "NOT_CLEARED"
    || clearance.status === "NEEDS_REVIEW"
    || (clearance.status === "EXPIRING" && clearance.warnStaff);
}

/**
 * The only wording a club ever sees (#427): never the issues text or a
 * reason. Cleared, Expiring (date), Not cleared, or Pending.
 */
export function clubDriverLabel(status: DriverClearanceStatus, expiresOn: string | null) {
  switch (status) {
    case "CLEARED": return "Cleared to drive";
    case "EXPIRING": return expiresOn ? `Expiring (${formatIssueDate(expiresOn)})` : "Cleared to drive";
    case "NOT_CLEARED": return "Not cleared";
    case "NEEDS_REVIEW": return "Pending";
  }
}

export const driverReasonLabels: Record<DriverClearanceReason, string> = {
  NON_DRIVER: "Marked Non-Driver",
  CHECK_NOT_COMPLIANT: "Background check marked not in compliance (n)",
  CHECK_EXPIRED: "Background check expired",
  CHECK_FLAGGED: "Background check marked expiring or needing attention (!)",
  NO_RECORD: "No matching background check",
  ISSUES_ON_CLEAR_CHECK: "Marked clear (y) but the issues column has text",
  UNRECOGNISED_ISSUES: "Issues text not recognised",
};
