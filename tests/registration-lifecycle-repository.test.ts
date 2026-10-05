import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getRegistrationById: vi.fn(),
  enqueueRegistrationCancelledMessage: vi.fn(),
  enqueueRegistrationReactivatedMessage: vi.fn(),
  enqueueWaitlistJoinedMessage: vi.fn(),
  enqueueWaitlistPromotedMessage: vi.fn(),
  enqueueWaitlistRemovedMessage: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
  return { ...actual, logWarn: dependencies.logWarn };
});

const lodgingMocks = vi.hoisted(() => ({ noteLodgingOnAdmission: vi.fn() }));
vi.mock("@/modules/lodging/registration-form", () => lodgingMocks);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/registrations/repository", () => ({
  getRegistrationById: dependencies.getRegistrationById,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueRegistrationCancelledMessage:
    dependencies.enqueueRegistrationCancelledMessage,
  enqueueRegistrationReactivatedMessage:
    dependencies.enqueueRegistrationReactivatedMessage,
  enqueueWaitlistJoinedMessage: dependencies.enqueueWaitlistJoinedMessage,
  enqueueWaitlistPromotedMessage: dependencies.enqueueWaitlistPromotedMessage,
  enqueueWaitlistRemovedMessage: dependencies.enqueueWaitlistRemovedMessage,
}));

import {
  cancelRegistration,
  moveRegistrationToWaitlist,
  promoteRegistrationFromWaitlist,
  promoteWaitlistAfterSeatsFreed,
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
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    locationWaitlistChange: { create: vi.fn().mockResolvedValue({ id: "change-1" }) },
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
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
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
  lodgingMocks.noteLodgingOnAdmission.mockResolvedValue({ hasRequest: false });
  const queued = {
    messageIds: ["message-1"],
    pendingMessageIds: ["message-1"],
    deliveryMode: "LOCAL_CAPTURE",
    skippedReason: null,
  };
  dependencies.enqueueRegistrationCancelledMessage.mockResolvedValue(queued);
  dependencies.enqueueRegistrationReactivatedMessage.mockResolvedValue(queued);
  dependencies.enqueueWaitlistJoinedMessage.mockResolvedValue(queued);
  dependencies.enqueueWaitlistPromotedMessage.mockResolvedValue(queued);
  dependencies.enqueueWaitlistRemovedMessage.mockResolvedValue(queued);
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
    // Only the promoted registration's lodging request is touched (locks and capacity version), never the one that did not fit.
    expect(lodgingMocks.noteLodgingOnAdmission).toHaveBeenCalledTimes(1);
    expect(lodgingMocks.noteLodgingOnAdmission).toHaveBeenCalledWith(tx, expect.any(String), fitting.id);
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

  it("removes a waitlisted registration with its prior position and safe operator reason", async () => {
    const { prisma, tx } = transactionFixture();
    const waitlisted = registration({
      status: "WAITLISTED",
      waitlistEntry: { id: "entry-1", status: "WAITING", position: 4 },
    });
    tx.registration.findFirst.mockResolvedValue(waitlisted);
    dependencies.getPrisma.mockReturnValue(prisma);

    await cancelRegistration(
      event.id,
      waitlisted.id,
      "user-1",
      "Registrant chose a different event.",
      new Date("2026-08-12T12:00:00.000Z"),
    );

    expect(tx.registrationWaitlistEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-1" },
      data: {
        status: "REMOVED",
        removedAt: new Date("2026-08-12T12:00:00.000Z"),
        lastBlockedReason: "Registrant chose a different event.",
      },
    });
    expect(dependencies.enqueueWaitlistRemovedMessage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        registrationId: waitlisted.id,
        waitlistPosition: 4,
        waitlistRemovalReason: "Registrant chose a different event.",
        metadata: expect.objectContaining({
          waitlistPosition: 4,
          reason: "Registrant chose a different event.",
        }),
      }),
    );
    expect(dependencies.enqueueRegistrationCancelledMessage).not.toHaveBeenCalled();
    expect(dependencies.enqueueWaitlistPromotedMessage).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          fromStatus: "WAITLISTED",
          toStatus: "CANCELLED",
          waitlistPosition: 4,
          reason: "Registrant chose a different event.",
        }),
      }),
    });
  });

  it("rejects a duplicate waitlist removal without adding another delivery intent", async () => {
    const { prisma, tx } = transactionFixture();
    tx.registration.findFirst.mockResolvedValue(registration({ status: "CANCELLED" }));
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(cancelRegistration(
      event.id,
      "registration-1",
      "user-1",
      "Repeated request.",
    )).rejects.toMatchObject({ code: "INVALID_REGISTRATION_TRANSITION" });

    expect(dependencies.enqueueWaitlistRemovedMessage).not.toHaveBeenCalled();
    expect(dependencies.enqueueRegistrationCancelledMessage).not.toHaveBeenCalled();
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

    const result = await reactivateRegistration(
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
    expect(result).toMatchObject({
      registration: { id: cancelled.id },
      pendingMessageIds: ["message-1"],
    });
    expect(dependencies.enqueueRegistrationReactivatedMessage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        registrationId: cancelled.id,
        transitionKey: expect.stringMatching(/^REGISTRATION_REACTIVATED:/),
        metadata: expect.objectContaining({ restoredStatus: "CONFIRMED" }),
      }),
    );
  });

  it("restores a cancelled submitted registration to submitted and queues its confirmation", async () => {
    const { prisma, tx } = transactionFixture();
    const cancelled = registration({ status: "CANCELLED" });
    tx.registration.findFirst.mockResolvedValue(cancelled);
    tx.auditLog.findFirst.mockResolvedValue(null);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await reactivateRegistration(
      event.id,
      cancelled.id,
      "user-1",
      "Cancellation was entered in error.",
    );

    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: cancelled.id },
      data: { status: "SUBMITTED", cancelledAt: null },
    });
    expect(result).toMatchObject({
      registration: { id: cancelled.id },
      pendingMessageIds: ["message-1"],
    });
    expect(dependencies.enqueueRegistrationReactivatedMessage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        metadata: expect.objectContaining({ restoredStatus: "SUBMITTED" }),
      }),
    );
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
    expect(dependencies.enqueueWaitlistPromotedMessage).toHaveBeenCalledOnce();
    expect(dependencies.enqueueWaitlistRemovedMessage).not.toHaveBeenCalled();
  });
});

describe("promotion and restoring respect the registration's location capacity (#413)", () => {
  function atLocation(seatsElsewhere: number, capacity: number | null) {
    const { prisma, tx } = transactionFixture();
    const queryRaw = vi.fn().mockResolvedValue([{ id: "loc-1", eventId: event.id, name: "Des Moines", capacity, isActive: true }]);
    Object.assign(tx, { $queryRaw: queryRaw, $executeRawUnsafe: vi.fn().mockResolvedValue(0) });
    // The event has room; only seats at the location are counted per location.
    tx.registrationAttendee.count.mockImplementation(async ({ where }: { where: { registration?: { locationId?: string } } }) => (
      where.registration?.locationId ? seatsElsewhere : 0
    ));
    const waitlisted = registration({
      status: "WAITLISTED",
      locationId: "loc-1",
      attendees: [attendee("a-1"), attendee("a-2")],
      waitlistEntry: { id: "entry-1", status: "WAITING", position: 1 },
    });
    tx.registration.findFirst.mockResolvedValue(waitlisted);
    dependencies.getPrisma.mockReturnValue(prisma);
    return { tx, queryRaw, waitlisted };
  }
  const promote = (id: string) => promoteRegistrationFromWaitlist(event.id, id, "user-1", "A place opened.", new Date("2026-08-12T12:00:00.000Z"));

  it("refuses to promote a waitlisted registration into a full location, under the location lock", async () => {
    const { tx, queryRaw, waitlisted } = atLocation(2, 3);
    await expect(promote(waitlisted.id)).rejects.toMatchObject({
      code: "EVENT_CAPACITY_UNAVAILABLE",
      message: expect.stringContaining("Des Moines has 1 remaining spot, but this registration needs 2"),
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.registration.update).not.toHaveBeenCalled();
  });

  it("promotes when the location has room", async () => {
    const { tx, waitlisted } = atLocation(1, 3);
    await promote(waitlisted.id);
    expect(tx.registration.update).toHaveBeenCalledWith({ where: { id: waitlisted.id }, data: { status: "SUBMITTED", cancelledAt: null } });
  });

  it("takes no location lock for a registration without a location", async () => {
    const { prisma, tx } = transactionFixture();
    const waitlisted = registration({ status: "WAITLISTED", waitlistEntry: { id: "entry-1", status: "WAITING", position: 1 } });
    tx.registration.findFirst.mockResolvedValue(waitlisted);
    dependencies.getPrisma.mockReturnValue(prisma);
    await promote(waitlisted.id);
    expect((tx as { $queryRaw?: unknown }).$queryRaw).toBeUndefined();
  });
});

describe("auto-promotion on cancel skips a candidate whose location is busy (#413)", () => {
  it("blocks that candidate, promotes the next, and the cancellation still succeeds", async () => {
    const { prisma, tx } = transactionFixture();
    const raw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      void strings;
      if (values[0] === "loc-busy") throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      return [{ id: String(values[0]), eventId: event.id, name: "Kansas City", capacity: null, isActive: true }];
    });
    const statements: string[] = [];
    Object.assign(tx, {
      $queryRaw: raw,
      $executeRawUnsafe: vi.fn(async (sql: string) => { statements.push(sql); return 0; }),
    });
    const cancelled = registration({ id: "cancelled-registration", confirmationCode: "REG-CANCEL" });
    const busy = registration({
      id: "waitlist-busy", confirmationCode: "REG-BUSY", status: "WAITLISTED", locationId: "loc-busy",
      waitlistEntry: { id: "entry-busy", status: "WAITING", position: 1 },
    });
    const fitting = registration({
      id: "waitlist-fit", confirmationCode: "REG-FIT", status: "WAITLISTED", locationId: "loc-ok",
      waitlistEntry: { id: "entry-fit", status: "WAITING", position: 2 },
    });
    tx.registration.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (
      [cancelled, busy, fitting].find((candidate) => candidate.id === where.id) ?? null
    ));
    tx.registrationWaitlistEntry.findMany.mockResolvedValue([
      { id: "entry-busy", registrationId: busy.id, position: 1 },
      { id: "entry-fit", registrationId: fitting.id, position: 2 },
    ]);
    dependencies.getPrisma.mockReturnValue(prisma);

    await cancelRegistration(event.id, cancelled.id, "user-1", "Cancelled.", new Date("2026-08-12T12:00:00.000Z"));

    expect(statements).toContain("SAVEPOINT auto_promote_candidate");
    expect(statements).toContain("ROLLBACK TO SAVEPOINT auto_promote_candidate");
    expect(tx.registrationWaitlistEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-busy" },
      data: { lastBlockedReason: expect.stringContaining("location was busy") },
    });
    // The cancellation went through and the next candidate was promoted.
    expect(tx.registration.update).toHaveBeenCalledWith({ where: { id: cancelled.id }, data: expect.objectContaining({ status: "CANCELLED" }) });
    expect(tx.registration.update).toHaveBeenCalledWith({ where: { id: fitting.id }, data: { status: "SUBMITTED", cancelledAt: null } });
    expect(tx.registration.update).not.toHaveBeenCalledWith({ where: { id: busy.id }, data: expect.anything() });
  });
});

describe("location waitlists (#599)", () => {
  const when = new Date("2026-08-12T12:00:00.000Z");
  const locationRow = (id: string) => ({ id, eventId: event.id, name: id === "loc-1" ? "Des Moines" : "Kansas City", capacity: null, isActive: true });

  /** A transaction whose location locks succeed and whose reads answer for the given registrations. */
  function locationFixture(registrations: Array<ReturnType<typeof registration>>, queue: Array<{ id: string; registrationId: string; position: number; locationId: string | null }> = []) {
    const { prisma, tx } = transactionFixture();
    Object.assign(tx, {
      $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => [locationRow(String(values[0]))]),
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    });
    tx.registration.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => registrations.find((candidate) => candidate.id === where.id) ?? null);
    tx.registrationWaitlistEntry.findMany.mockResolvedValue(queue.map((entry) => ({
      id: entry.id, registrationId: entry.registrationId, position: entry.position, registration: { locationId: entry.locationId },
    })));
    dependencies.getPrisma.mockReturnValue(prisma);
    return tx;
  }
  const waiting = (id: string, locationId: string | null, position: number, people = 1) => registration({
    id, confirmationCode: `REG-${id.toUpperCase()}`, status: "WAITLISTED", locationId,
    attendees: Array.from({ length: people }, (_, index) => attendee(`${id}-${index}`)),
    waitlistEntry: { id: `entry-${id}`, status: "WAITING", position },
  });
  const recordedChange = (tx: ReturnType<typeof transactionFixture>["tx"]) => tx.locationWaitlistChange.create.mock.calls.map(([call]) => call.data);
  const club = { locationId: "loc-1", location: { name: "Des Moines" }, _count: { attendees: 2 }, clubRegistration: { organization: { name: "Test Pathfinders" } }, eventId: event.id, confirmationCode: "REG-CLUB" };

  it("records a promotion at a location with the club, the people and its place in line, and tells the director that place", async () => {
    const promoted = waiting("w1", "loc-1", 7, 2);
    const tx = locationFixture([promoted]);
    tx.registrationWaitlistEntry.findUnique.mockResolvedValue({ position: 7, status: "WAITING" });
    tx.registrationWaitlistEntry.count.mockResolvedValue(2);
    tx.registration.findUnique.mockResolvedValue(club);
    await promoteRegistrationFromWaitlist(event.id, promoted.id, "user-1", "A place opened.", when);
    expect(recordedChange(tx)).toEqual([expect.objectContaining({
      kind: "PROMOTED", eventId: event.id, locationId: "loc-1", registrationId: "w1", clubName: "Test Pathfinders",
      locationName: "Des Moines", attendeeCount: 2, place: 2, occurredAt: when,
    })]);
    expect(tx.registrationWaitlistEntry.count).toHaveBeenCalledWith({ where: { status: "WAITING", position: { lte: 7 }, registration: { locationId: "loc-1", status: "WAITLISTED" } } });
    expect(dependencies.enqueueWaitlistPromotedMessage).toHaveBeenCalledWith(tx, expect.objectContaining({ waitlistPosition: 2 }));
  });

  it("records a waitlisted club leaving the waitlist with the place it held, and tells the director that place", async () => {
    const leaving = waiting("w2", "loc-1", 9);
    const tx = locationFixture([leaving]);
    tx.registrationWaitlistEntry.findUnique.mockResolvedValue({ position: 9, status: "WAITING" });
    tx.registrationWaitlistEntry.count.mockResolvedValue(3);
    tx.registration.findUnique.mockResolvedValue({ ...club, _count: { attendees: 1 } });
    await cancelRegistration(event.id, leaving.id, "user-1", "Changed plans.", when);
    expect(recordedChange(tx)).toEqual([expect.objectContaining({ kind: "REMOVED", registrationId: "w2", place: 3, attendeeCount: 1 })]);
    expect(dependencies.enqueueWaitlistRemovedMessage).toHaveBeenCalledWith(tx, expect.objectContaining({ waitlistPosition: 3 }));
  });

  it("records a club moved onto the waitlist at its location, with its place", async () => {
    const moving = registration({ id: "m1", locationId: "loc-1" });
    const tx = locationFixture([moving]);
    tx.registrationWaitlistEntry.aggregate.mockResolvedValue({ _max: { position: 4 } });
    tx.registrationWaitlistEntry.findUnique.mockResolvedValue({ position: 5, status: "WAITING" });
    tx.registrationWaitlistEntry.count.mockResolvedValue(1);
    tx.registration.findUnique.mockResolvedValue(club);
    await moveRegistrationToWaitlist(event.id, moving.id, "user-1", "Over capacity.", when);
    expect(recordedChange(tx)).toEqual([expect.objectContaining({ kind: "JOINED", registrationId: "m1", place: 1 })]);
    expect(dependencies.enqueueWaitlistJoinedMessage).toHaveBeenCalledWith(tx, expect.objectContaining({ waitlistPosition: 1 }));
  });

  it("looks up and records nothing for a registration with no location", async () => {
    const plain = waiting("w3", null, 2);
    const tx = locationFixture([plain]);
    await promoteRegistrationFromWaitlist(event.id, plain.id, "user-1", "", when);
    expect(tx.registrationWaitlistEntry.findUnique).not.toHaveBeenCalled();
    expect(tx.registration.findUnique).not.toHaveBeenCalled();
    expect(tx.locationWaitlistChange.create).not.toHaveBeenCalled();
    expect(dependencies.enqueueWaitlistPromotedMessage).toHaveBeenCalledWith(tx, expect.objectContaining({ waitlistPosition: 2 }));
  });

  it("offers a freed seat to the next club at that location first, even when a club at another location is earlier in the event queue", async () => {
    const cancelled = registration({ id: "cancelled", confirmationCode: "REG-CANCEL", locationId: "loc-1" });
    const elsewhere = waiting("elsewhere", "loc-2", 1);
    const here = waiting("here", "loc-1", 2);
    const tx = locationFixture([cancelled, elsewhere, here], [
      { id: "entry-elsewhere", registrationId: "elsewhere", position: 1, locationId: "loc-2" },
      { id: "entry-here", registrationId: "here", position: 2, locationId: "loc-1" },
    ]);
    await cancelRegistration(event.id, cancelled.id, "user-1", "Cancelled.", when);
    expect(tx.registration.update).toHaveBeenCalledWith({ where: { id: "here" }, data: { status: "SUBMITTED", cancelledAt: null } });
    expect(tx.registration.update).not.toHaveBeenCalledWith({ where: { id: "elsewhere" }, data: expect.anything() });
  });

  it("offers a seat freed at a location to the event queue in order when nobody waits at that location", async () => {
    const cancelled = registration({ id: "cancelled", confirmationCode: "REG-CANCEL", locationId: "loc-1" });
    const first = waiting("first", "loc-2", 1);
    const second = waiting("second", null, 2);
    const tx = locationFixture([cancelled, first, second], [
      { id: "entry-first", registrationId: "first", position: 1, locationId: "loc-2" },
      { id: "entry-second", registrationId: "second", position: 2, locationId: null },
    ]);
    await cancelRegistration(event.id, cancelled.id, "user-1", "Cancelled.", when);
    expect(tx.registration.update).toHaveBeenCalledWith({ where: { id: "first" }, data: { status: "SUBMITTED", cancelledAt: null } });
    expect(tx.registration.update).not.toHaveBeenCalledWith({ where: { id: "second" }, data: expect.anything() });
  });

  describe("promoteWaitlistAfterSeatsFreed", () => {
    const trigger = { locationId: "loc-1", reason: "Automatically promoted after the capacity was raised." };

    it("does nothing, and reads no queue, when the event has no waitlist or auto-promotion is off", async () => {
      for (const flags of [{ waitlistEnabled: false, autoPromoteWaitlist: false }, { waitlistEnabled: true, autoPromoteWaitlist: false }]) {
        const tx = locationFixture([]);
        tx.event.findUnique.mockResolvedValue({ ...event, ...flags });
        const result = await promoteWaitlistAfterSeatsFreed(tx as never, { eventId: event.id, actorUserId: "user-1", trigger, now: when });
        expect(result).toEqual({ promotedRegistrationIds: [], pendingMessageIds: [] });
        expect(tx.registrationWaitlistEntry.findMany).not.toHaveBeenCalled();
      }
    });

    it("promotes only one club by default and every club that fits, in order, when asked to repeat", async () => {
      const queue = [
        { id: "entry-a", registrationId: "a", position: 1, locationId: "loc-1" },
        { id: "entry-b", registrationId: "b", position: 2, locationId: "loc-1" },
      ];
      const candidates = [waiting("a", "loc-1", 1), waiting("b", "loc-1", 2)];
      const one = locationFixture(candidates, queue);
      const single = await promoteWaitlistAfterSeatsFreed(one as never, { eventId: event.id, actorUserId: "user-1", trigger, now: when });
      expect(single.promotedRegistrationIds).toEqual(["a"]);

      // Once "a" is promoted it is no longer waiting, which the queue read reflects.
      const many = locationFixture(candidates, queue);
      many.registrationWaitlistEntry.findMany
        .mockResolvedValueOnce(queue.map((entry) => ({ ...entry, registration: { locationId: entry.locationId } })))
        .mockResolvedValueOnce(queue.slice(1).map((entry) => ({ ...entry, registration: { locationId: entry.locationId } })))
        .mockResolvedValue([]);
      const all = await promoteWaitlistAfterSeatsFreed(many as never, { eventId: event.id, actorUserId: "user-1", trigger, now: when, repeat: true });
      expect(all.promotedRegistrationIds).toEqual(["a", "b"]);
      expect(all.pendingMessageIds).toEqual(["message-1", "message-1"]);
    });

    it("waits on a busy location once, not again in every round of a repeating pass", async () => {
      const queue = [
        { id: "entry-busy-1", registrationId: "busy-1", position: 1, locationId: "loc-busy" },
        { id: "entry-busy-2", registrationId: "busy-2", position: 2, locationId: "loc-busy" },
        { id: "entry-ok", registrationId: "ok", position: 3, locationId: "loc-ok" },
      ];
      const candidates = [waiting("busy-1", "loc-busy", 1), waiting("busy-2", "loc-busy", 2), waiting("ok", "loc-ok", 3)];
      const tx = locationFixture(candidates, queue);
      const raw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        if (values[0] === "loc-busy") throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
        return [locationRow(String(values[0]))];
      });
      Object.assign(tx, { $queryRaw: raw });
      const rows = (entries: typeof queue) => entries.map((entry) => ({ ...entry, registration: { locationId: entry.locationId } }));
      tx.registrationWaitlistEntry.findMany.mockResolvedValueOnce(rows(queue)).mockResolvedValueOnce(rows(queue.slice(0, 2))).mockResolvedValue([]);
      const result = await promoteWaitlistAfterSeatsFreed(tx as never, { eventId: event.id, actorUserId: "user-1", trigger: { locationId: "loc-busy", reason: "Raised." }, now: when, repeat: true });
      expect(result.promotedRegistrationIds).toEqual(["ok"]);
      // One wait on the busy location for the whole pass, though two clubs wait there and the pass ran twice.
      expect(raw.mock.calls.filter(([, ...values]) => values[0] === "loc-busy")).toHaveLength(1);
    });

    it("does not rewrite a blocked reason the entry already carries, so concurrent passes do not wait on the same row", async () => {
      const busyReason = "The registration's location was busy, so it was not promoted automatically. Promote it by hand.";
      const stale = waiting("busy-1", "loc-busy", 1);
      (stale.waitlistEntry as unknown as Record<string, unknown>).lastBlockedReason = busyReason;
      const fresh = waiting("busy-2", "loc-busy", 2);
      const tx = locationFixture([stale, fresh], [
        { id: "entry-busy-1", registrationId: "busy-1", position: 1, locationId: "loc-busy" },
        { id: "entry-busy-2", registrationId: "busy-2", position: 2, locationId: "loc-busy" },
      ]);
      Object.assign(tx, { $queryRaw: vi.fn(async () => { throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }); }) });
      await promoteWaitlistAfterSeatsFreed(tx as never, { eventId: event.id, actorUserId: "user-1", trigger: { locationId: "loc-busy", reason: "Raised." }, now: when });
      // The first entry already says so, the second (never blocked) is skipped as busy without a write either.
      expect(tx.registrationWaitlistEntry.update).not.toHaveBeenCalled();
      const changed = waiting("busy-3", "loc-busy", 3);
      const tx2 = locationFixture([changed], [{ id: "entry-busy-3", registrationId: "busy-3", position: 3, locationId: "loc-busy" }]);
      Object.assign(tx2, { $queryRaw: vi.fn(async () => { throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }); }) });
      await promoteWaitlistAfterSeatsFreed(tx2 as never, { eventId: event.id, actorUserId: "user-1", trigger: { locationId: "loc-busy", reason: "Raised." }, now: when });
      expect(tx2.registrationWaitlistEntry.update).toHaveBeenCalledWith({ where: { id: "entry-busy-3" }, data: { lastBlockedReason: busyReason } });
    });

    it("warns when a repeating pass reaches its round limit", async () => {
      const queue = [{ id: "entry-a", registrationId: "a", position: 1, locationId: "loc-1" }];
      // The read model never shows the club leaving the queue, so the pass keeps promoting until the cap.
      const tx = locationFixture([waiting("a", "loc-1", 1)], queue);
      const result = await promoteWaitlistAfterSeatsFreed(tx as never, { eventId: event.id, actorUserId: "user-1", trigger, now: when, repeat: true });
      expect(result.promotedRegistrationIds).toHaveLength(50);
      expect(dependencies.logWarn).toHaveBeenCalledWith(expect.stringContaining("round limit"), expect.objectContaining({ eventId: event.id }));
    });

    it("does not warn when the pass ends on its own", async () => {
      const tx = locationFixture([waiting("a", "loc-1", 1)], [{ id: "entry-a", registrationId: "a", position: 1, locationId: "loc-1" }]);
      await promoteWaitlistAfterSeatsFreed(tx as never, { eventId: event.id, actorUserId: "user-1", trigger, now: when });
      expect(dependencies.logWarn).not.toHaveBeenCalled();
    });

    it("gives the promotion the trigger's reason and accepts no actor, as an amendment by a club director has none", async () => {
      const tx = locationFixture([waiting("a", "loc-1", 1)], [{ id: "entry-a", registrationId: "a", position: 1, locationId: "loc-1" }]);
      await promoteWaitlistAfterSeatsFreed(tx as never, { eventId: event.id, actorUserId: null, trigger, now: when });
      expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        action: "REGISTRATION_AUTO_PROMOTED_FROM_WAITLIST", actorUserId: null,
        metadata: expect.objectContaining({ reason: trigger.reason }),
      }) });
    });
  });
});
