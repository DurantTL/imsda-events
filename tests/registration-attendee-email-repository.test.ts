import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  RegistrationAttendeeOperationError,
  updateRegistrationAttendeeEmail,
} from "@/modules/registrations/repository";

function fixture() {
  const tx = {
    registrationAttendee: {
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    registrationAttendee: {
      findFirst: vi.fn().mockResolvedValue({
        id: "attendee-1",
        profileSnapshot: { firstName: "Avery", lastName: "Guest", email: "old@example.test" },
        registration: { confirmationCode: "REG-ONE" },
      }),
    },
    registration: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  return { prisma, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateRegistrationAttendeeEmail", () => {
  it("merges the new email into the attendee's profile snapshot and audits the change", async () => {
    const { prisma, tx } = fixture();
    dependencies.getPrisma.mockReturnValue(prisma);

    await updateRegistrationAttendeeEmail(
      "event-1",
      "registration-1",
      "attendee-1",
      "new@example.test",
      "user-1",
    );

    expect(prisma.registrationAttendee.findFirst).toHaveBeenCalledWith({
      where: { id: "attendee-1", registrationId: "registration-1", eventId: "event-1" },
      select: expect.any(Object),
    });
    expect(tx.registrationAttendee.update).toHaveBeenCalledWith({
      where: { id: "attendee-1" },
      data: {
        profileSnapshot: {
          firstName: "Avery",
          lastName: "Guest",
          email: "new@example.test",
        },
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: "event-1",
        actorUserId: "user-1",
        action: "REGISTRATION_ATTENDEE_EMAIL_UPDATED",
        entityType: "RegistrationAttendee",
        entityId: "attendee-1",
      }),
    });
  });

  it("clears the email when given an empty string", async () => {
    const { prisma, tx } = fixture();
    dependencies.getPrisma.mockReturnValue(prisma);

    await updateRegistrationAttendeeEmail("event-1", "registration-1", "attendee-1", "", "user-1");

    expect(tx.registrationAttendee.update).toHaveBeenCalledWith({
      where: { id: "attendee-1" },
      data: {
        profileSnapshot: expect.objectContaining({ email: null }),
      },
    });
  });

  it("throws ATTENDEE_NOT_FOUND when the attendee is not on this registration", async () => {
    const { prisma, tx } = fixture();
    prisma.registrationAttendee.findFirst.mockResolvedValue(null);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(
      updateRegistrationAttendeeEmail("event-1", "registration-1", "attendee-1", "new@example.test", "user-1"),
    ).rejects.toMatchObject({
      code: "ATTENDEE_NOT_FOUND",
    });
    await expect(
      updateRegistrationAttendeeEmail("event-1", "registration-1", "attendee-1", "new@example.test", "user-1"),
    ).rejects.toBeInstanceOf(RegistrationAttendeeOperationError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.registrationAttendee.update).not.toHaveBeenCalled();
  });
});
