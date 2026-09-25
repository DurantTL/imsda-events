import { describe, expect, it } from "vitest";
import { mfaGateFor, requiresMfa } from "@/modules/access/mfa-rules";

describe("who has to carry a second factor", () => {
  it("requires it of every system administrator, even with no membership", () => {
    expect(requiresMfa({ globalRole: "SYSTEM_ADMIN", activeEventRoles: [] })).toBe(true);
  });

  it("requires it of an event administrator", () => {
    expect(requiresMfa({ globalRole: null, activeEventRoles: ["EVENT_ADMIN"] })).toBe(true);
  });

  // Decision 2026-09-25 (#456): every active event role now carries the same
  // requirement, not only EVENT_ADMIN and SYSTEM_ADMIN.
  it("requires it of ordinary event staff too", () => {
    for (const role of ["REGISTRATION_MANAGER", "FINANCE_MANAGER", "COMMUNICATIONS_MANAGER", "CHECK_IN_STAFF", "READ_ONLY_STAFF"]) {
      expect(requiresMfa({ globalRole: null, activeEventRoles: [role] })).toBe(true);
    }
  });

  it("does not require it of a staff account with no active membership", () => {
    expect(requiresMfa({ globalRole: null, activeEventRoles: [] })).toBe(false);
  });
});

describe("the sign-in gate", () => {
  // Any active membership now requires a second factor (#456), so this fixture
  // for "carries the requirement" is ordinary event staff, not an admin role.
  const staff = { globalRole: null, activeEventRoles: ["CHECK_IN_STAFF"] } as const;
  const admin = { globalRole: "SYSTEM_ADMIN", activeEventRoles: [] } as const;
  // No active membership at all — the one case still left on the password alone.
  const unassigned = { globalRole: null, activeEventRoles: [] } as const;

  it("asks for a code from anyone with a confirmed authenticator", () => {
    expect(mfaGateFor(staff, { status: "ACTIVE" })).toEqual({ kind: "challenge" });
    expect(mfaGateFor(admin, { status: "ACTIVE" })).toEqual({ kind: "challenge" });
  });

  it("sends a privileged account with no authenticator to enrol", () => {
    expect(mfaGateFor(admin, null)).toEqual({ kind: "enrol" });
    // A half-finished enrolment is not a second factor.
    expect(mfaGateFor(admin, { status: "PENDING" })).toEqual({ kind: "enrol" });
  });

  it("sends ordinary event staff with no authenticator to enrol too (#456)", () => {
    expect(mfaGateFor(staff, null)).toEqual({ kind: "enrol" });
    expect(mfaGateFor(staff, { status: "PENDING" })).toEqual({ kind: "enrol" });
  });

  it("lets a staff account with no active membership through on the password alone", () => {
    expect(mfaGateFor(unassigned, null)).toEqual({ kind: "not_required" });
    expect(mfaGateFor(unassigned, { status: "PENDING" })).toEqual({ kind: "not_required" });
  });
});
