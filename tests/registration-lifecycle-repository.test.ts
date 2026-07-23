import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getRegistrationById: vi.fn(),
  enqueueRegistrationCancelledMessage: vi.fn(),
  enqueueWaitlistJoinedMessage: vi.fn(),
  enqueueWaitlistPromotedMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/registrations/repository", () => ({
  getRegistrationById: dependencies.getRegistrationById,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueRegistrationCancelledMessage:
    dependencies.enqueueRegistrationCancelledMessage,
  enqueueWaitlistJoinedMessage: dependencies.enqueueWaitlistJoinedMessage,
  enqueueWaitlistPromotedMessage: dependencies.enqueueWaitlistPromotedMessage,
}));

import {
  cancelRegistration,
  moveRegistrationToWaitlist,
  promoteRegistrationFromWaitlist,
  reactivateRegistration,
} from "@/modules/registrations/lifecycle-repository";

const event = {
  id: "event-1",
  name: "Lifecycle Test Event",
  capacity: 3,
  waitlistEnabled: true,
  autoPromoteWaitlist: true,
};

function attendee(id: string) {
  return { id, position: 0, formResponses: {} };
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    id: "registration-1",
    eventId: event.id,
    confirmationCode: "REG-ONE",
    status: "SUBMITTED",
    totalAmount: 125,
    attendees: [attendee("attendee-1")],
    capacityReservations: [],
    publicFormSubmission: null,
    waitlistEntry: null,
    ...overrides,
  };
}

function transactionFixture() {
  const tx = {
    event: { findUnique: vi.fn().mockResolvedValue(event) },
    registration: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    registrationAttendee: {
      count: vi.fn().mockResolvedValue(0),
    },
    registrationCapacityReservation: {
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
    registrationWaitlistEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _max: { position: null } }),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  return { prisma, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
  const queued = {
    messageIds: ["message-1"],
    pendingMessageIds: ["message-1"],
    deliveryMode: "LOCAL_CAPTURE",
    skippedReason: null,
  };
  dependencies.enqueueRegistrationCancelledMessage.mockResolvedValue(queued);
  dependencies.enqueueWaitlistJoinedMessage.mockResolvedValue(queued);
  dependencies.enqueueWaitlistPromotedMessage.mockResolvedValue(queued);
  dependencies.getRegistrationById.mockImplementation(async (_eventId, registrationId) => ({
    id: registrationId,
  }));
});

describe("registration lifecycle repository", () => {
  it("cancels, releases inventory, and auto-promotes the earliest queue entry that fits", async () => {
    const { prisma, tx } = transactionFixture();
    const cancelled = registration({
      id: "cancelled-registration",
      confirmationCode: "REG-CANCEL",
      capacityReservations: [{ id: "reservation-live" }],
    });
    const tooLarge = registration({
      id: "waitlist-large",
      confirmationCode: "REG-LARGE",
      status: "WAITLISTED",
      attendees: [attendee("large-1"), attendee("large-2")],
      waitlistEntry: { id: "entry-large", status: "WAITING", position: 1 },
    });
    const fitting = registration({
      id: "waitlist-fit",
      confirmationCode: "REG-FIT",
      status: "WAITLISTED",
      attendees: [attendee("fit-1")],
      waitlistEntry: { id: "entry-fit", status: "WAITING", position: 2 },
    });
    tx.registration.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (
      where.id === cancelled.id ? cancelled : where.id === tooLarge.id ? tooLarge : fitting
    ));
    tx.registrationCapacityReservation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 });
    tx.registrationAttendee.count.mockResolvedValue(2);
    tx.registrationWaitlistEntry.findMany.mockResolvedValue([
      { id: "entry-large", registrationId: tooLarge.id, position: 1 },
      { id: "entry-fit", registrationId: fitting.id, position: 2 },
    ]);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await cancelRegistration(
      event.id,
      cancelled.id,
      "user-1",
      "Registrant requested cancellation.",
      new Date("2026-08-12T12:00:00.000Z"),
    );

    expect(result).toMatchObject({
      registration: { id: cancelled.id },
      autoPromotedRegistration: { id: fitting.id },
    });
    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: cancelled.id },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: fitting.id },
      data: { status: "SUBMITTED", cancelledAt: null },
    });
    expect(tx.registrationWaitlistEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-large" },
      data: expect.objectContaining({
        lastBlockedReason: expect.stringContaining("remaining spot"),
      }),
    });
    expect(tx.registrationWaitlistEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-fit" },
      data: expect.objectContaining({ status: "PROMOTED" }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    expect(dependencies.enqueueRegistrationCancelledMessage)
      .toHaveBeenCalledWith(tx, expect.objectContaining({
        registrationId: cancelled.id,
      }));
    expect(dependencies.enqueueWaitlistPromotedMessage)
      .toHaveBeenCalledWith(tx, expect.objectContaining({
        registrationId: fitting.id,
      }));
    for (const call of tx.registration.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty("totalAmount");
      expect(call[0].data).not.toHaveProperty("payments");
    }
  });

  it("moves an active registration to the end of the enabled waitlist without changing its balance", async () => {
    const { prisma, tx } = transactionFixture();
    const active = registration({
      status: "CONFIRMED",
      capacityReservations: [{ id: "reservation-live" }],
    });
    tx.registration.findFirst.mockResolvedValue(active);
    tx.registrationCapacityReservation.updateMany.mockResolvedValue({ count: 1 });
    tx.registrationWaitlistEntry.aggregate.mockResolvedValue({ _max: { position: 5 } });
    dependencies.getPrisma.mockReturnValue(prisma);

    await moveRegistrationToWaitlist(
      event.id,
      active.id,
      "user-1",
      "Holding the registration while plans change.",
      new Date("2026-08-12T12:00:00.000Z"),
    );

    expect(tx.registrationWaitlistEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: event.id,
        registrationId: active.id,
        position: 6,
        status: "WAITING",
      }),
    });
    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: active.id },
      data: { status: "WAITLISTED", cancelledAt: null },
    });
    expect(tx.registration.update.mock.calls[0][0].data).not.toHaveProperty("totalAmount");
    expect(dependencies.enqueueWaitlistJoinedMessage)
      .toHaveBeenCalledWith(tx, expect.objectContaining({
        registrationId: active.id,
        waitlistPosition: 6,
      }));
  });

  it("reactivates a cancelled registration only after event and option capacity are available", async () => {
    const { prisma, tx } = transactionFixture();
    const definition = {
      title: "Capacity form",
      description: "",
      confirmationMessage: "Received.",
      sections: [{
        id: "choices",
        title: "Choices",
        description: "",
        fields: [{
          id: "room-field",
          key: "room",
          label: "Room",
          helpText: "",
          type: "RADIO",
          scope: "REGISTRATION",
          required: true,
          options: ["Cabin", "Commuting"],
          availabilityMode: "CAPACITY",
          choiceLimits: { Cabin: 2 },
        }],
      }],
    };
    const cancelled = registration({
      status: "CANCELLED",
      capacityReservations: [{
        id: "released-room",
        participantKey: "registration",
        fieldId: "room-field",
        optionValue: "Cabin",
      }],
      publicFormSubmission: {
        responses: { room: "Cabin" },
        formVersion: { id: "version-1", formId: "form-1", definition },
      },
    });
    tx.registration.findFirst.mockResolvedValue(cancelled);
    tx.auditLog.findFirst.mockResolvedValue({ metadata: { fromStatus: "CONFIRMED" } });
    dependencies.getPrisma.mockReturnValue(prisma);

    await reactivateRegistration(
      event.id,
      cancelled.id,
      "user-1",
      "Cancellation was entered in error.",
      new Date("2026-08-12T12:00:00.000Z"),
    );

    expect(tx.registrationCapacityReservation.count).toHaveBeenCalled();
    expect(tx.registrationCapacityReservation.update).toHaveBeenCalledWith({
      where: { id: "released-room" },
      data: {
        registrationAttendeeId: null,
        rank: null,
        releasedAt: null,
      },
    });
    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: cancelled.id },
      data: { status: "CONFIRMED", cancelledAt: null },
    });
    expect(tx.registration.update.mock.calls[0][0].data).not.toHaveProperty("totalAmount");
  });

  it("blocks manual promotion when an immutable option selection no longer fits", async () => {
    const { prisma, tx } = transactionFixture();
    const definition = {
      title: "Capacity form",
      description: "",
      confirmationMessage: "Received.",
      sections: [{
        id: "choices",
        title: "Choices",
        description: "",
        fields: [{
          id: "room-field",
          key: "room",
          label: "Room",
          helpText: "",
          type: "RADIO",
          scope: "REGISTRATION",
          required: true,
          options: ["Cabin", "Commuting"],
          availabilityMode: "CAPACITY",
          choiceLimits: { Cabin: 1 },
        }],
      }],
    };
    const waitlisted = registration({
      status: "WAITLISTED",
      waitlistEntry: { id: "entry-1", status: "WAITING", position: 1 },
      publicFormSubmission: {
        responses: { room: "Cabin" },
        formVersion: { id: "version-1", formId: "form-1", definition },
      },
    });
    tx.registration.findFirst.mockResolvedValue(waitlisted);
    tx.registrationCapacityReservation.count.mockResolvedValue(1);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(promoteRegistrationFromWaitlist(
      event.id,
      waitlisted.id,
      "user-1",
      "Manual promotion.",
      new Date("2026-08-12T12:00:00.000Z"),
    )).rejects.toMatchObject({
      code: "OPTION_CAPACITY_UNAVAILABLE",
      details: expect.objectContaining({ optionValue: "Cabin", remaining: 0 }),
    });
    expect(tx.registration.update).not.toHaveBeenCalled();
    expect(tx.registrationCapacityReservation.update).not.toHaveBeenCalled();
    expect(tx.registrationCapacityReservation.create).not.toHaveBeenCalled();
  });

  it("restores ranked interest reservations without treating assignment room limits as submission capacity", async () => {
    const { prisma, tx } = transactionFixture();
    const definition = {
      title: "Seminar form",
      description: "",
      confirmationMessage: "Received.",
      sections: [{
        id: "seminars",
        title: "Seminars",
        description: "",
        fields: [{
          id: "seminar-field",
          key: "seminar_preferences",
          label: "Seminar preferences",
          helpText: "",
          type: "RANKED_CHOICE",
          scope: "ATTENDEE",
          required: true,
          options: ["Seminar A", "Seminar B"],
          minSelections: 2,
          maxSelections: 2,
          availabilityMode: "RANKED_INTEREST",
          choiceLimits: { "Seminar A": 1, "Seminar B": 1 },
        }],
      }],
    };
    const waitlisted = registration({
      id: "ranked-waitlist",
      status: "WAITLISTED",
      attendees: [{
        id: "attendee-1",
        position: 0,
        formResponses: {
          seminar_preferences: ["Seminar A", "Seminar B"],
        },
      }],
      waitlistEntry: { id: "entry-ranked", status: "WAITING", position: 1 },
      publicFormSubmission: {
        responses: {},
        formVersion: { id: "version-1", formId: "form-1", definition },
      },
    });
    tx.registration.findFirst.mockResolvedValue(waitlisted);
    tx.registrationCapacityReservation.count.mockResolvedValue(99);
    dependencies.getPrisma.mockReturnValue(prisma);

    await promoteRegistrationFromWaitlist(
      event.id,
      waitlisted.id,
      "user-1",
      "A place opened.",
      new Date("2026-08-12T12:00:00.000Z"),
    );

    expect(tx.registrationCapacityReservation.count).not.toHaveBeenCalled();
    expect(tx.registrationCapacityReservation.create).toHaveBeenCalledTimes(2);
    expect(tx.registrationCapacityReservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fieldId: "seminar-field",
        optionValue: "Seminar A",
        rank: 0,
      }),
    });
    expect(tx.registrationCapacityReservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fieldId: "seminar-field",
        optionValue: "Seminar B",
        rank: 1,
      }),
    });
    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: waitlisted.id },
      data: { status: "SUBMITTED", cancelledAt: null },
    });
  });

  it("reconstructs and activates option reservations when promoting an initially waitlisted submission", async () => {
    const { prisma, tx } = transactionFixture();
    const definition = {
      title: "Capacity form",
      description: "",
      confirmationMessage: "Received.",
      sections: [{
        id: "choices",
        title: "Choices",
        description: "",
        fields: [{
          id: "room-field",
          key: "room",
          label: "Room",
          helpText: "",
          type: "RADIO",
          scope: "REGISTRATION",
          required: true,
          options: ["Cabin", "Commuting"],
          availabilityMode: "CAPACITY",
          choiceLimits: { Cabin: 2 },
        }],
      }],
    };
    const waitlisted = registration({
      id: "initial-waitlist",
      status: "WAITLISTED",
      capacityReservations: [],
      waitlistEntry: { id: "entry-1", status: "WAITING", position: 1 },
      publicFormSubmission: {
        responses: { room: "Cabin" },
        formVersion: { id: "version-1", formId: "form-1", definition },
      },
    });
    tx.registration.findFirst.mockResolvedValue(waitlisted);
    dependencies.getPrisma.mockReturnValue(prisma);

    await promoteRegistrationFromWaitlist(
      event.id,
      waitlisted.id,
      "user-1",
      "A place opened.",
      new Date("2026-08-12T12:00:00.000Z"),
    );

    expect(tx.registrationCapacityReservation.create).toHaveBeenCalledWith({
      data: {
        eventId: event.id,
        formId: "form-1",
        formVersionId: "version-1",
        registrationId: waitlisted.id,
        registrationAttendeeId: null,
        participantKey: "registration",
        fieldId: "room-field",
        fieldKey: "room",
        optionValue: "Cabin",
        rank: null,
      },
    });
    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: waitlisted.id },
      data: { status: "SUBMITTED", cancelledAt: null },
    });
    expect(tx.registrationWaitlistEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-1" },
      data: expect.objectContaining({ status: "PROMOTED", lastBlockedReason: null }),
    });
  });
});
