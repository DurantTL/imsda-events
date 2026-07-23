import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  canManageProgramAssignments,
  requireProgramAssignmentAccess,
} from "@/modules/program-assignments/access";

const session = {
  user: {
    id: "user_one",
    email: "staff@example.test",
    displayName: "Staff Member",
  },
};

describe("program assignment access", () => {
  it("requires registration management and sensitive-data access together", () => {
    expect(canManageProgramAssignments([
      "MANAGE_REGISTRATION",
      "VIEW_SENSITIVE_DATA",
    ])).toBe(true);
    expect(canManageProgramAssignments(["MANAGE_REGISTRATION"])).toBe(false);
    expect(canManageProgramAssignments([
      "MANAGE_FORMS",
      "VIEW_SENSITIVE_DATA",
    ])).toBe(false);
  });

  it("rejects a custom form manager who can view sensitive data but cannot manage registrations", async () => {
    const lookup = vi.fn().mockResolvedValue({
      eventId: "event_one",
      userId: "user_one",
      role: "READ_ONLY_STAFF",
      status: "ACTIVE",
      permissions: ["MANAGE_FORMS", "VIEW_SENSITIVE_DATA"],
    });

    await expect(requireProgramAssignmentAccess(
      session,
      "event_one",
      lookup,
    )).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      status: 403,
    });
  });
});
