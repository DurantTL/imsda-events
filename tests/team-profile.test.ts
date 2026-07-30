import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => prismaMock,
}));

import {
  TeamProfileError,
  updateTeamProfile,
} from "@/modules/system-admin/team-profile";

describe("team profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renames a team member, normalizes blank profile fields, and audits the change", async () => {
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "user-2",
          email: "helper@example.test",
          displayName: "Old Name",
          jobTitle: "Helper",
          phone: "555-0100",
          bio: "Old notes",
        }),
        update: vi.fn().mockResolvedValue({
          id: "user-2",
          email: "helper@example.test",
          displayName: "New Name",
          jobTitle: null,
          phone: null,
          bio: null,
        }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    prismaMock.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(updateTeamProfile("user-2", "admin-1", {
      displayName: "  New Name ",
      jobTitle: "",
      phone: " ",
      bio: "",
    })).resolves.toMatchObject({ displayName: "New Name" });

    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-2" },
      data: {
        displayName: "New Name",
        jobTitle: null,
        phone: null,
        bio: null,
      },
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "admin-1",
        action: "STAFF_PROFILE_UPDATED",
        entityType: "User",
        entityId: "user-2",
      }),
    });
  });

  it("refuses to update an account that no longer exists", async () => {
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    prismaMock.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(updateTeamProfile("missing", "admin-1", {
      displayName: "Missing Person",
      jobTitle: "",
      phone: "",
      bio: "",
    })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    } satisfies Partial<TeamProfileError>);
  });
});
