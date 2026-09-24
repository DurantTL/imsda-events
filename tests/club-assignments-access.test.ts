import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  canManageClubAssignments,
  canSendClubAssignmentMessages,
  requireClubAssignmentAccess,
  requireClubAssignmentMessageAccess,
} from "@/modules/club-registrations/assignments-access";

const session = {
  user: { id: "user_one", email: "staff@example.test", displayName: "Staff Member" },
};

describe("club assignment permissions", () => {
  it("requires MANAGE_REGISTRATION to manage assignments", () => {
    expect(canManageClubAssignments(["MANAGE_REGISTRATION"])).toBe(true);
    expect(canManageClubAssignments(["VIEW_EVENT"])).toBe(false);
  });

  it("requires MANAGE_COMMUNICATIONS to send the assignment email, separately from editing", () => {
    expect(canSendClubAssignmentMessages(["MANAGE_COMMUNICATIONS"])).toBe(true);
    expect(canSendClubAssignmentMessages(["MANAGE_REGISTRATION"])).toBe(false);
  });

  it("rejects a check-in-only staff member from editing assignments", async () => {
    const lookup = vi.fn().mockResolvedValue({
      eventId: "event_one",
      userId: "user_one",
      role: "CHECK_IN_STAFF",
      status: "ACTIVE",
      permissions: [],
    });
    await expect(requireClubAssignmentAccess(session, "event_one", lookup))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED", status: 403 });
  });

  it("allows a registration manager to edit assignments", async () => {
    const lookup = vi.fn().mockResolvedValue({
      eventId: "event_one",
      userId: "user_one",
      role: "REGISTRATION_MANAGER",
      status: "ACTIVE",
      permissions: [],
    });
    await expect(requireClubAssignmentAccess(session, "event_one", lookup)).resolves.toBeDefined();
  });

  it("rejects a registration manager from sending the assignment email", async () => {
    const lookup = vi.fn().mockResolvedValue({
      eventId: "event_one",
      userId: "user_one",
      role: "REGISTRATION_MANAGER",
      status: "ACTIVE",
      permissions: [],
    });
    await expect(requireClubAssignmentMessageAccess(session, "event_one", lookup))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED", status: 403 });
  });

  it("allows a communications manager to send the assignment email", async () => {
    const lookup = vi.fn().mockResolvedValue({
      eventId: "event_one",
      userId: "user_one",
      role: "COMMUNICATIONS_MANAGER",
      status: "ACTIVE",
      permissions: [],
    });
    await expect(requireClubAssignmentMessageAccess(session, "event_one", lookup)).resolves.toBeDefined();
  });

  it("lets a system admin do both without a membership lookup result", async () => {
    const adminSession = { user: { ...session.user, globalRole: "SYSTEM_ADMIN" as const } };
    const lookup = vi.fn().mockResolvedValue(null);
    await expect(requireClubAssignmentAccess(adminSession, "event_one", lookup)).resolves.toBeDefined();
    await expect(requireClubAssignmentMessageAccess(adminSession, "event_one", lookup)).resolves.toBeDefined();
  });
});
