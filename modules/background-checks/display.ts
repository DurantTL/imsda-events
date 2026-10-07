/**
 * Display constants and types for Sterling Volunteers. Client-safe: this file
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
  missing: "with no Sterling Volunteers record",
  expired: "expired or not in compliance",
  expiring: "expiring within 60 days",
};

/** How a flag reads on the list and in its CSV. */
export const backgroundFlagLabels = {
  MISSING: "None on file",
  EXPIRED: "Expired",
  NOT_COMPLIANT: "Not in compliance",
} as const satisfies Record<Exclude<BackgroundCheckState, "CURRENT">, string>;
