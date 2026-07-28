import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { refusesAccountDisable } from "@/modules/system-admin/account-status";

const base = {
  targetUserId: "user-2",
  actorUserId: "user-1",
  targetIsSystemAdmin: false,
  otherEnabledSystemAdminCount: 2,
};

describe("refusing to disable an account", () => {
  it("allows disabling an ordinary account", () => {
    expect(refusesAccountDisable(base)).toBeNull();
  });

  it("refuses disabling yourself", () => {
    // The one mistake nobody can undo from inside the application.
    expect(refusesAccountDisable({ ...base, targetUserId: "user-1" }))
      .toBe("CANNOT_DISABLE_SELF");
  });

  it("refuses removing the last system administrator who can sign in", () => {
    expect(refusesAccountDisable({
      ...base,
      targetIsSystemAdmin: true,
      otherEnabledSystemAdminCount: 0,
    })).toBe("LAST_SYSTEM_ADMIN");
  });

  it("allows disabling a system administrator while another can still sign in", () => {
    expect(refusesAccountDisable({
      ...base,
      targetIsSystemAdmin: true,
      otherEnabledSystemAdminCount: 1,
    })).toBeNull();
  });

  it("checks self before the administrator count", () => {
    // The last administrator disabling themselves must be refused for the
    // reason they can act on, not the one that sounds like someone else's
    // problem.
    expect(refusesAccountDisable({
      ...base,
      targetUserId: "user-1",
      targetIsSystemAdmin: true,
      otherEnabledSystemAdminCount: 0,
    })).toBe("CANNOT_DISABLE_SELF");
  });
});
