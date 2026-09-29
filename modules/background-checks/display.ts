/**
 * Display constants and types for background checks. Client-safe: this file
 * must never import a module that reaches `node:` (#550), because client
 * components (the club roster, the flag badges) import it. The rules that
 * read a check live in `domain.ts`, which re-exports everything here.
 */

export type BackgroundCheckState = "CURRENT" | "EXPIRED" | "MISSING" | "NOT_COMPLIANT";

export type ClubComplianceState = "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | "NO_RECORD";

/** The `?compliance=` roster filter value each reminder links to. */
export const COMPLIANCE_FILTER_VALUES = ["missing", "expired", "expiring"] as const;
export type ComplianceFilterValue = (typeof COMPLIANCE_FILTER_VALUES)[number];

/** Which roster state a `?compliance=` filter value narrows the roster to. */
export const complianceFilterState: Record<ComplianceFilterValue, ClubComplianceState> = {
  missing: "NO_RECORD",
  expired: "NOT_COMPLIANT",
  expiring: "FLAGGED",
};

/** How the roster's active filter reads back to whoever followed the link. */
export const complianceFilterLabels: Record<ComplianceFilterValue, string> = {
  missing: "missing a current background check",
  expired: "expired or not in compliance",
  expiring: "expiring within 60 days",
};

/** How a flag reads on the list and in its CSV. */
export const backgroundFlagLabels = {
  MISSING: "None on file",
  EXPIRED: "Expired",
  NOT_COMPLIANT: "Not in compliance",
} as const satisfies Record<Exclude<BackgroundCheckState, "CURRENT">, string>;

/**
 * Driver clearance wording (#544). The staff queue and the club driver list
 * import it. The rules that decide a status live in
 * `modules/driver-verification/clearance.ts`.
 */
export type DriverClearanceStatus = "CLEARED" | "EXPIRING" | "NOT_CLEARED" | "NEEDS_REVIEW";

/** Why a status is what it is. Staff only: these describe the note and the check. */
export type DriverClearanceReason =
  | "NON_DRIVER"
  | "CHECK_NOT_COMPLIANT"
  | "CHECK_EXPIRED"
  | "CHECK_FLAGGED"
  | "NO_RECORD"
  | "ISSUE_DATE_PASSED"
  | "ISSUES_ON_CLEAR_CHECK"
  | "UNRECOGNISED_ISSUES";

export const driverReasonLabels: Record<DriverClearanceReason, string> = {
  NON_DRIVER: "Marked Non-Driver",
  CHECK_NOT_COMPLIANT: "Background check marked not in compliance (n)",
  CHECK_EXPIRED: "Background check expired",
  CHECK_FLAGGED: "Background check marked expiring or needing attention (!)",
  NO_RECORD: "No matching background check",
  ISSUE_DATE_PASSED: "A BGC or Training date in the issues column has passed",
  ISSUES_ON_CLEAR_CHECK: "Marked clear (y) but the issues column has text",
  UNRECOGNISED_ISSUES: "Issues text not recognised",
};

/**
 * The only wording a club ever sees of a driver's clearance (#427): never
 * the issues text or a reason. `expiresOn` is a "YYYY-MM-DD" calendar date.
 */
export function clubDriverLabel(status: DriverClearanceStatus, expiresOn: string | null) {
  switch (status) {
    case "CLEARED": return "Cleared to drive";
    case "EXPIRING": {
      if (!expiresOn) return "Cleared to drive";
      const [year, month, day] = expiresOn.split("-");
      return `Expiring (${month}/${day}/${year})`;
    }
    case "NOT_CLEARED": return "Not cleared";
    case "NEEDS_REVIEW": return "Pending";
  }
}
