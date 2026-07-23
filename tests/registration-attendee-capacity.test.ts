import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  addRegistrationAttendee,
  RegistrationAttendeeOperationError,
} from "@/modules/registrations/repository";

const input = {
  firstName: "Second",
  lastName: "Attendee",
  email: "second.attendee@example.test",
  phone: "",
  attendeeType: "ATTENDEE" as const,
};

function transactionFixture() {
  const tx = {
    registration: {
      findFirst: vi.fn().mockResolvedValue({
        id: "registration-1",
        confirmationCode: "REG-ONE",
        status: "SUBMITTED",
        publicFormSubmission: null,
        event: { capacity: 3 },
      }),
    },
    registrationAttendee: {
      count: vi.fn().mockResolvedValue(1),
      aggregate: vi.fn().mockResolvedValue({ _max: { position: 0 } }),
      create: vi.fn().mockResolvedValue({ id: "attendee-2" }),
    },
    person: {
      upsert: vi.fn().mockResolvedValue({ id: "person-2" }),
      create: vi.fn().mockResolvedValue({ id: "person-2" }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
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

describe("staff registration attendee capacity", () => {
  it("checks active event occupancy in a serializable transaction before adding an attendee", async () => {
    const { prisma, tx } = transactionFixture();
    dependencies.getPrisma.mockReturnValue(prisma);

    await addRegistrationAttendee(
      "event-1",
      "registration-1",
      input,
      "user-1",
    );

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
    expect(tx.registrationAttendee.count).toHaveBeenCalledWith({
      where: {
        eventId: "event-1",
        registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
      },
    });
    expect(tx.registrationAttendee.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: "event-1",
        registrationId: "registration-1",
        personId: "person-2",
        position: 1,
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "REGISTRATION_ATTENDEE_ADDED",
        metadata: {
          registrationId: "registration-1",
          occupiedBefore: 1,
          eventCapacity: 3,
        },
      }),
    });
  });

  it.each(["DRAFT", "WAITLISTED", "CANCELLED"] as const)(
    "rejects attendee changes while a registration is %s",
    async (status) => {
      const { prisma, tx } = transactionFixture();
      tx.registration.findFirst.mockResolvedValue({
        id: "registration-1",
        confirmationCode: "REG-ONE",
        status,
        publicFormSubmission: null,
        event: { capacity: 3 },
      });
      dependencies.getPrisma.mockReturnValue(prisma);

      await expect(addRegistrationAttendee(
        "event-1",
        "registration-1",
        input,
        "user-1",
      )).rejects.toMatchObject({
        code: "REGISTRATION_NOT_ACTIVE",
        details: { currentStatus: status },
      });
      expect(tx.registrationAttendee.count).not.toHaveBeenCalled();
      expect(tx.registrationAttendee.create).not.toHaveBeenCalled();
    },
  );

  it("requires a form-aware edit workflow for public-form registrations", async () => {
    const { prisma, tx } = transactionFixture();
    tx.registration.findFirst.mockResolvedValue({
      id: "registration-1",
      confirmationCode: "REG-ONE",
      status: "CONFIRMED",
      publicFormSubmission: { id: "submission-1" },
      event: { capacity: 3 },
    });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(addRegistrationAttendee(
      "event-1",
      "registration-1",
      input,
      "user-1",
    )).rejects.toBeInstanceOf(RegistrationAttendeeOperationError);
    await expect(addRegistrationAttendee(
      "event-1",
      "registration-1",
      input,
      "user-1",
    )).rejects.toMatchObject({
      code: "PUBLIC_FORM_ATTENDEE_EDIT_REQUIRES_FORM",
    });
    expect(tx.registrationAttendee.count).not.toHaveBeenCalled();
  });

  it("returns a typed conflict without writing when the event is full", async () => {
    const { prisma, tx } = transactionFixture();
    tx.registrationAttendee.count.mockResolvedValue(3);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(addRegistrationAttendee(
      "event-1",
      "registration-1",
      input,
      "user-1",
    )).rejects.toMatchObject({
      code: "EVENT_CAPACITY_UNAVAILABLE",
      details: {
        occupied: 3,
        requested: 1,
        remaining: 0,
      },
    });
    expect(tx.person.upsert).not.toHaveBeenCalled();
    expect(tx.registrationAttendee.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
