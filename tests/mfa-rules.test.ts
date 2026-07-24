import { describe, expect, it } from "vitest";
import { mfaGateFor, requiresMfa } from "@/modules/access/mfa-rules";

describe("who has to carry a second factor", () => {
  it("requires it of every system administrator", () => {
    expect(requiresMfa({ globalRole: "SYSTEM_ADMIN", activeEventRoles: [] })).toBe(true);
  });

  it("requires it of an event administrator", () => {
    expect(requiresMfa({ globalRole: null, activeEventRoles: ["EVENT_ADMIN"] })).toBe(true);
    expect(requiresMfa({
      globalRole: null,
      activeEventRoles: ["READ_ONLY_STAFF", "EVENT_ADMIN"],
    })).toBe(true);
  });

  it("does not require it of the other event roles", () => {
    // Check-in and registration staff work from shared tablets at an event; the
    // roster export and staff management that make MFA non-optional are not
    // theirs.
    expect(requiresMfa({
      globalRole: null,
      activeEventRoles: ["REGISTRATION_MANAGER", "CHECK_IN_STAFF", "READ_ONLY_STAFF"],
    })).toBe(false);
  });
});

describe("the sign-in gate", () => {
  const staff = { globalRole: null, activeEventRoles: ["CHECK_IN_STAFF"] } as const;
  const admin = { globalRole: "SYSTEM_ADMIN", activeEventRoles: [] } as const;

  it("asks for a code from anyone with a confirmed authenticator", () => {
    expect(mfaGateFor(staff, { status: "ACTIVE" })).toEqual({ kind: "challenge" });
    expect(mfaGateFor(admin, { status: "ACTIVE" })).toEqual({ kind: "challenge" });
  });

  it("sends a privileged account with no authenticator to enrol", () => {
    expect(mfaGateFor(admin, null)).toEqual({ kind: "enrol" });
    // A half-finished enrolment is not a second factor.
    expect(mfaGateFor(admin, { status: "PENDING" })).toEqual({ kind: "enrol" });
  });

  it("lets everyone else through on the password alone", () => {
    expect(mfaGateFor(staff, null)).toEqual({ kind: "not_required" });
    expect(mfaGateFor(staff, { status: "PENDING" })).toEqual({ kind: "not_required" });
  });
});
