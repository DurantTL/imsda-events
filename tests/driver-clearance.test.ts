import { describe, expect, it } from "vitest";
import { ROSTER_EXPORT_COLUMN_KEYS } from "@/modules/club-rosters/export-columns";
import {
  clubDriverLabel,
  deriveDriverClearance,
  DRIVER_EXPIRY_WARNING_DAYS,
  isDriverException,
  needsStaffAction,
  overrideIsStale,
  overrideLapsedByDate,
  type DriverCheckEvidence,
  type DriverClearanceStatus,
} from "@/modules/driver-verification/clearance";

const today = "2026-10-01";
const y = "CLEAR" as const;
const n = "NOT_COMPLIANT" as const;
const bang = "FLAGGED" as const;

function check(complianceStatus: DriverCheckEvidence["complianceStatus"], issuesNote: string | null): DriverCheckEvidence {
  return { complianceStatus, expiresOn: null, issuesNote };
}

const statusOf = (mark: DriverCheckEvidence["complianceStatus"], issues: string | null) =>
  deriveDriverClearance(check(mark, issues), today).status;

describe("automatic driver clearance (#544)", () => {
  it("names the warning window as a constant", () => {
    expect(DRIVER_EXPIRY_WARNING_DAYS).toBe(30);
  });

  // Every issues text below, against every compliance mark.
  const matrix: Array<[string, string | null, Record<"y" | "n" | "!", DriverClearanceStatus>]> = [
    ["blank", "", { y: "CLEARED", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["null", null, { y: "CLEARED", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["Non-Driver", "Non-Driver", { y: "NOT_CLEARED", n: "NOT_CLEARED", "!": "NOT_CLEARED" }],
    ["non driver, odd case", "  NON  driver ", { y: "NOT_CLEARED", n: "NOT_CLEARED", "!": "NOT_CLEARED" }],
    ["undated BGC", "BGC", { y: "NEEDS_REVIEW", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["undated Training", "Training", { y: "NEEDS_REVIEW", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["past-dated BGC", "BGC (09/30/26)", { y: "NOT_CLEARED", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["past-dated Training beside a future BGC", "Training (09/01/26), BGC (10/04/26)", { y: "NOT_CLEARED", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["future-dated Training", "Training (10/04/26)", { y: "EXPIRING", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["two future dates", "Training (10/04/26),BGC (10/04/26)", { y: "EXPIRING", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["future date beside an undated one", "Training (10/04/26), BGC", { y: "NEEDS_REVIEW", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["future date beside Non-Driver", "BGC (10/04/26), Non-Driver", { y: "NOT_CLEARED", n: "NOT_CLEARED", "!": "NOT_CLEARED" }],
    ["unknown item", "Fingerprints pending", { y: "NEEDS_REVIEW", n: "NOT_CLEARED", "!": "NEEDS_REVIEW" }],
    ["unknown item beside Non-Driver", "Fingerprints pending, Non-Driver", { y: "NOT_CLEARED", n: "NOT_CLEARED", "!": "NOT_CLEARED" }],
  ];

  it.each(matrix)("%s", (_name, issues, expected) => {
    expect(statusOf(y, issues)).toBe(expected.y);
    expect(statusOf(n, issues)).toBe(expected.n);
    expect(statusOf(bang, issues)).toBe(expected["!"]);
  });

  it("needs review with no matching check", () => {
    expect(deriveDriverClearance(null, today)).toMatchObject({ status: "NEEDS_REVIEW", reasons: ["NO_RECORD"] });
    expect(deriveDriverClearance(undefined, today).status).toBe("NEEDS_REVIEW");
  });

  it("never lets issues text change a y, only sends it to staff", () => {
    const result = deriveDriverClearance(check(y, "BGC"), today);
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.reasons).toContain("ISSUES_ON_CLEAR_CHECK");
    expect(deriveDriverClearance(check(y, ""), today).status).toBe("CLEARED");
  });

  it("clears a driver whose only dated item is ahead, showing the date, and only warns staff inside the window", () => {
    const soon = deriveDriverClearance(check(y, "BGC (10/31/26)"), today);
    expect(soon).toMatchObject({ status: "EXPIRING", expiresOn: "2026-10-31", warnStaff: true });
    expect(isDriverException(soon)).toBe(true);
    const later = deriveDriverClearance(check(y, "BGC (11/01/26)"), today);
    expect(later).toMatchObject({ status: "EXPIRING", expiresOn: "2026-11-01", warnStaff: false });
    expect(isDriverException(later)).toBe(false);
  });

  it("lasts through the date, and is expired the day after (injected today)", () => {
    expect(deriveDriverClearance(check(y, "BGC (10/01/26)"), "2026-10-01").status).toBe("EXPIRING");
    expect(deriveDriverClearance(check(y, "BGC (10/01/26)"), "2026-10-02")).toMatchObject({ status: "NOT_CLEARED", reasons: ["ISSUE_DATE_PASSED"] });
  });

  it("shows staff a future date even when the mark isn't y", () => {
    expect(deriveDriverClearance(check(bang, "BGC (10/04/26)"), today)).toMatchObject({ status: "NEEDS_REVIEW", expiresOn: "2026-10-04" });
  });

  it("reads a Sterling row (no mark) by its expiration date", () => {
    expect(deriveDriverClearance({ expiresOn: "2027-01-01" }, today).status).toBe("CLEARED");
    expect(deriveDriverClearance({ expiresOn: "2026-09-30" }, today).status).toBe("NOT_CLEARED");
    expect(deriveDriverClearance({ expiresOn: null }, today).status).toBe("NEEDS_REVIEW");
    expect(deriveDriverClearance({ expiresOn: "2027-01-01", issuesNote: "Non-Driver" }, today).status).toBe("NOT_CLEARED");
  });

  it("uses a Sterling row's own expiry as the expiring date inside the 30-day window (N3)", () => {
    expect(deriveDriverClearance({ expiresOn: "2026-10-31" }, today)).toMatchObject({ status: "EXPIRING", expiresOn: "2026-10-31", warnStaff: true });
    expect(deriveDriverClearance({ expiresOn: "2026-10-01" }, today)).toMatchObject({ status: "EXPIRING", expiresOn: "2026-10-01", warnStaff: true });
    expect(deriveDriverClearance({ expiresOn: "2026-11-01" }, today)).toMatchObject({ status: "CLEARED", expiresOn: null });
    // The soonest of an issues date and the row's own expiry is shown.
    expect(deriveDriverClearance({ expiresOn: "2026-10-20", issuesNote: "BGC (10/10/26)" }, today).expiresOn).toBe("2026-10-10");
  });

  it("puts only exceptions in the staff queue", () => {
    const exception = (status: DriverClearanceStatus) => isDriverException({ status, reasons: [], expiresOn: null, warnStaff: false });
    expect(exception("CLEARED")).toBe(false);
    expect(exception("EXPIRING")).toBe(false);
    expect(exception("NOT_CLEARED")).toBe(true);
    expect(exception("NEEDS_REVIEW")).toBe(true);
  });
});

describe("staff overrides against the list (#544)", () => {
  const derived = (status: DriverClearanceStatus, warnStaff = false) => ({ status, reasons: [], expiresOn: null, warnStaff });
  const cleared = { clearedToTransport: true };
  const refused = { clearedToTransport: false };

  it("goes stale once a newer list arrives, and not before", () => {
    const reviewedAt = new Date("2026-10-01T12:00:00Z");
    expect(overrideIsStale(reviewedAt, new Date("2026-10-01T12:00:01Z"))).toBe(true);
    expect(overrideIsStale(reviewedAt, new Date("2026-10-01T12:00:00Z"))).toBe(false);
    expect(overrideIsStale(reviewedAt, new Date("2026-09-30T12:00:00Z"))).toBe(false);
    // Nothing matched, so no list to compare with: it stands.
    expect(overrideIsStale(reviewedAt, null)).toBe(false);
    expect(overrideIsStale(reviewedAt, undefined)).toBe(false);
  });

  it("lapses when a date on the list passes after it was made, and not for a date already past", () => {
    const dated = (issuesNote: string) => ({ complianceStatus: "CLEAR" as const, expiresOn: null, issuesNote });
    expect(overrideLapsedByDate(dated("BGC (10/15/26)"), "2026-10-01", "2026-10-15")).toBe(false);
    expect(overrideLapsedByDate(dated("BGC (10/15/26)"), "2026-10-01", "2026-10-16")).toBe(true);
    expect(overrideLapsedByDate(dated("BGC (10/15/26)"), "2026-10-15", "2026-10-16")).toBe(true);
    expect(overrideLapsedByDate(dated("BGC (09/15/26)"), "2026-10-01", "2026-10-16")).toBe(false);
    expect(overrideLapsedByDate(dated(""), "2026-10-01", "2026-12-01")).toBe(false);
    // A Sterling row's own expiry counts; a row with a mark ignores expiresOn.
    expect(overrideLapsedByDate({ expiresOn: "2026-10-15" }, "2026-10-01", "2026-10-16")).toBe(true);
    expect(overrideLapsedByDate({ complianceStatus: "CLEAR", expiresOn: "2026-10-15" }, "2026-10-01", "2026-10-16")).toBe(false);
    expect(overrideLapsedByDate(null, "2026-10-01", "2026-10-16")).toBe(false);
  });

  it("without an override, only exceptions need action", () => {
    expect(needsStaffAction(derived("CLEARED"), null)).toBe(false);
    expect(needsStaffAction(derived("EXPIRING"), null)).toBe(false);
    expect(needsStaffAction(derived("EXPIRING", true), null)).toBe(true);
    expect(needsStaffAction(derived("NOT_CLEARED"), null)).toBe(true);
    expect(needsStaffAction(derived("NEEDS_REVIEW"), null)).toBe(true);
  });

  it("an override that agrees with the list, or resolves a needs-review, leaves the queue", () => {
    expect(needsStaffAction(derived("NOT_CLEARED"), refused)).toBe(false);
    expect(needsStaffAction(derived("CLEARED"), cleared)).toBe(false);
    expect(needsStaffAction(derived("EXPIRING", true), cleared)).toBe(false);
    expect(needsStaffAction(derived("NEEDS_REVIEW"), cleared)).toBe(false);
    expect(needsStaffAction(derived("NEEDS_REVIEW"), refused)).toBe(false);
  });

  it("an override that disagrees with the list stays in the queue, so staff can undo it", () => {
    expect(needsStaffAction(derived("NOT_CLEARED"), cleared)).toBe(true);
    expect(needsStaffAction(derived("CLEARED"), refused)).toBe(true);
    expect(needsStaffAction(derived("EXPIRING"), refused)).toBe(true);
  });
});

describe("what a club sees of a driver's clearance (#427, #544)", () => {
  it("is one of four labels, with the date for expiring", () => {
    expect(clubDriverLabel("CLEARED", null)).toBe("Cleared to drive");
    expect(clubDriverLabel("EXPIRING", "2026-10-04")).toBe("Expiring (10/04/2026)");
    expect(clubDriverLabel("NOT_CLEARED", null)).toBe("Not cleared");
    expect(clubDriverLabel("NEEDS_REVIEW", null)).toBe("Pending");
  });

  it("never carries the issues text or a reason, whatever the status", () => {
    const text = "Synthetic Non-Driver note, BGC (10/04/26)";
    for (const mark of [y, n, bang] as const) {
      const clearance = deriveDriverClearance(check(mark, text), today);
      const label = clubDriverLabel(clearance.status, clearance.expiresOn);
      expect(label).not.toMatch(/non-driver|bgc|training|synthetic/i);
    }
  });

  it("is not a column a club can put in a roster export", () => {
    for (const key of ROSTER_EXPORT_COLUMN_KEYS) {
      expect(key).not.toMatch(/driver|issue|clearance|background|willing/i);
    }
  });
});
