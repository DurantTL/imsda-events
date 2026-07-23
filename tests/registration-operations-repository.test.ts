import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));
const messageMocks = vi.hoisted(() => ({
  enqueueRegistrationTransferredNewContactMessage: vi.fn(),
  enqueueRegistrationTransferredPriorContactMessage: vi.fn(),
  enqueueAttendeeSubstitutedMessage: vi.fn(),
}));
const registrationMocks = vi.hoisted(() => ({
  getRegistrationByIdWithClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: prismaMocks.getPrisma }));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueRegistrationTransferredNewContactMessage:
    messageMocks.enqueueRegistrationTransferredNewContactMessage,
  enqueueRegistrationTransferredPriorContactMessage:
    messageMocks.enqueueRegistrationTransferredPriorContactMessage,
  enqueueAttendeeSubstitutedMessage:
    messageMocks.enqueueAttendeeSubstitutedMessage,
}));
vi.mock("@/modules/registrations/repository", () => ({
  getRegistrationByIdWithClient:
    registrationMocks.getRegistrationByIdWithClient,
}));

import {
  substituteRegistrationAttendee,
  transferRegistration,
} from "@/modules/registrations/operations-repository";

const now = new Date("2026-07-23T16:00:00.000Z");
const actor = { id: "user-1", displayName: "Staff User" };
const transferInput = {
  clientRequestId: "1616c563-e266-44b4-8c9a-d77e88ac3923",
  firstName: "Morgan",
  lastName: "Lee",
  email: "morgan@example.test",
  phone: "555-0102",
  reason: "Family request",
};

function baseRegistration() {
  return {
    id: "registration-1",
    eventId: "event-1",
    accountHolderPersonId: "person-prior",
    confirmationCode: "REG-123",
    status: "CONFIRMED",
    totalAmount: { toString: () => "250.00" },
    contactSnapshot: {
      firstName: "Prior",
      lastName: "Contact",
      email: "prior@example.test",
      phone: "555-0100",
    },
    submittedAt: new Date("2026-07-01T12:00:00.000Z"),
    cancelledAt: null,
    createdAt: new Date("2026-07-01T11:55:00.000Z"),
    accountHolderPerson: {
      id: "person-prior",
      firstName: "Prior",
      lastName: "Contact",
      normalizedEmail: "prior@example.test",
      phone: "555-0100",
    },
    attendees: [
      {
        id: "attendee-1",
        eventId: "event-1",
        registrationId: "registration-1",
        personId: "person-attendee-1",
        attendeeType: "ATTENDEE",
        position: 0,
        profileSnapshot: {
          firstName: "Avery",
          lastName: "Guest",
          email: "avery@example.test",
          phone: "555-0110",
          source: "PUBLIC_REGISTRATION",
        },
        formResponses: { meal: "VEGAN" },
        createdAt: new Date("2026-07-01T12:00:00.000Z"),
        person: {
          id: "person-attendee-1",
          firstName: "Avery",
          lastName: "Guest",
          normalizedEmail: "avery@example.test",
          phone: "555-0110",
        },
        checkIns: [] as Array<{ id: string; checkedInAt: Date }>,
      },
      {
        id: "attendee-2",
        eventId: "event-1",
        registrationId: "registration-1",
        personId: "person-attendee-2",
        attendeeType: "CHILD",
        position: 1,
        profileSnapshot: {
          firstName: "Casey",
          lastName: "Guest",
          email: "",
          phone: "",
          source: "PUBLIC_REGISTRATION",
        },
        formResponses: { childcare: true },
        createdAt: new Date("2026-07-01T12:00:01.000Z"),
        person: {
          id: "person-attendee-2",
          firstName: "Casey",
          lastName: "Guest",
          normalizedEmail: null,
          phone: null,
        },
        checkIns: [] as Array<{ id: string; checkedInAt: Date }>,
      },
    ],
    publicFormSubmission: {
      id: "submission-1",
      formVersionId: "version-1",
      idempotencyKey: "e3e06803-fe09-4a7f-8a1e-49effe1b105c",
      requestHash: "request-hash",
      responses: { lodging: "LODGE" },
      attendeeResponses: [{ first_name: "Avery" }, { first_name: "Casey" }],
      pricingSnapshot: { totalCents: 25_000 },
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
    },
    payments: [{
      id: "payment-1",
      amount: { toString: () => "100.00" },
      status: "SUCCEEDED",
      method: "CARD_REFERENCE",
      externalReference: "safe-payment-reference",
      receivedAt: new Date("2026-07-02T12:00:00.000Z"),
      refunds: [{
        id: "refund-1",
        amount: { toString: () => "25.00" },
        status: "SUCCEEDED",
        externalReference: "safe-refund-reference",
        reason: "Adjustment",
        createdAt: new Date("2026-07-03T12:00:00.000Z"),
      }],
    }],
    capacityReservations: [{
      id: "reservation-1",
      registrationAttendeeId: "attendee-1",
      participantKey: "attendee:0",
      fieldId: "meal-field",
      fieldKey: "meal",
      optionValue: "VEGAN",
      rank: null,
      releasedAt: null,
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
    }],
    waitlistEntry: {
      id: "waitlist-1",
      position: 4,
      attendeeCount: 2,
      status: "PROMOTED",
      joinedAt: new Date("2026-07-01T12:00:00.000Z"),
      promotedAt: new Date("2026-07-05T12:00:00.000Z"),
      removedAt: null,
    },
    promoCodeRedemption: {
      id: "redemption-1",
      promoCodeId: "promo-1",
      codeSnapshot: "SAVE25",
      discountTypeSnapshot: "FIXED_CENTS",
      discountValueSnapshot: 2500,
      eligibleSubtotalCents: 27_500,
      discountAmountCents: 2500,
      pricingDate: "2026-07-01",
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
    },
  };
}

function fixture() {
  const registration = baseRegistration();
  let replay: Record<string, unknown> | null = null;
  const createdOperations: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const tx = {
    registrationOperation: {
      findUnique: vi.fn(async () => replay),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdOperations.push(data);
        return data;
      }),
    },
    registration: {
      findFirst: vi.fn(async () => registration),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (typeof data.accountHolderPersonId === "string") {
          registration.accountHolderPersonId = data.accountHolderPersonId;
        }
        if (data.contactSnapshot) {
          registration.contactSnapshot = data.contactSnapshot as typeof registration.contactSnapshot;
        }
        return registration;
      }),
    },
    registrationAttendee: {
      update: vi.fn(async ({ where, data }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const attendee = registration.attendees.find(
          (candidate) => candidate.id === where.id,
        )!;
        if (typeof data.personId === "string") attendee.personId = data.personId;
        if (data.profileSnapshot) {
          attendee.profileSnapshot = data.profileSnapshot as typeof attendee.profileSnapshot;
        }
        return attendee;
      }),
    },
    person: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "person-new" })),
    },
    registrationAccessToken: {
      count: vi.fn(async () => 2),
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      }),
    },
  };
  const transaction = vi.fn(async (
    operation: (client: typeof tx) => unknown,
  ) => operation(tx));
  prismaMocks.getPrisma.mockReturnValue({ $transaction: transaction });
  registrationMocks.getRegistrationByIdWithClient.mockResolvedValue({
    id: "registration-1",
    confirmationCode: "REG-123",
    accountHolder: {
      firstName: transferInput.firstName,
      lastName: transferInput.lastName,
      email: transferInput.email,
      phone: transferInput.phone,
    },
    attendees: [],
  });
  return {
    registration,
    tx,
    transaction,
    createdOperations,
    audits,
    setReplay(value: Record<string, unknown> | null) {
      replay = value;
    },
  };
}

const queued = (
  id: string,
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL" =
    "LOCAL_CAPTURE",
) => ({
  messageIds: [id],
  pendingMessageIds: deliveryMode === "DISABLED" ? [] : [id],
  deliveryMode,
  skippedReason: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  messageMocks.enqueueRegistrationTransferredNewContactMessage
    .mockResolvedValue(queued("message-new"));
  messageMocks.enqueueRegistrationTransferredPriorContactMessage
    .mockResolvedValue(queued("message-prior"));
  messageMocks.enqueueAttendeeSubstitutedMessage.mockImplementation(
    async (_tx, input: { recipientEmail: string }) => (
      queued(`message-${input.recipientEmail}`)
    ),
  );
});

describe("registration transfer repository", () => {
  it("changes only the destination, revokes active links, and stores an immutable exact replay", async () => {
    const store = fixture();

    const first = await transferRegistration(
      "event-1",
      "registration-1",
      transferInput,
      actor,
      now,
    );
    const created = store.createdOperations[0]!;
    store.setReplay({
      registrationId: "registration-1",
      attendeeId: null,
      type: "TRANSFER",
      requestFingerprint: created.requestFingerprint,
      responseSnapshot: created.responseSnapshot,
    });
    const replay = await transferRegistration(
      "event-1",
      "registration-1",
      transferInput,
      actor,
      now,
    );

    expect(store.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
    expect(store.tx.registration.update).toHaveBeenCalledOnce();
    expect(store.tx.registration.update).toHaveBeenCalledWith({
      where: { id: "registration-1" },
      data: {
        accountHolderPersonId: "person-new",
        contactSnapshot: expect.objectContaining({
          firstName: "Morgan",
          lastName: "Lee",
          email: "morgan@example.test",
          phone: "555-0102",
        }),
      },
    });
    expect(store.tx.registrationAccessToken.updateMany).toHaveBeenCalledWith({
      where: {
        registrationId: "registration-1",
        purpose: "MANAGE_REGISTRATION",
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });
    expect(store.tx.registrationAttendee.update).not.toHaveBeenCalled();
    expect(created).toMatchObject({
      eventId: "event-1",
      registrationId: "registration-1",
      type: "TRANSFER",
      clientRequestId: transferInput.clientRequestId,
      actorUserId: "user-1",
      actorNameSnapshot: "Staff User",
    });
    expect(JSON.stringify(created)).not.toMatch(/tokenHash|private-secret/);
    expect(first.response).toEqual(replay.response);
    expect(store.tx.registrationOperation.create).toHaveBeenCalledOnce();
    expect(store.tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it("rejects reuse of the same request ID with changed input", async () => {
    const store = fixture();
    const first = await transferRegistration(
      "event-1",
      "registration-1",
      transferInput,
      actor,
      now,
    );
    const created = store.createdOperations[0]!;
    store.setReplay({
      registrationId: "registration-1",
      attendeeId: null,
      type: "TRANSFER",
      requestFingerprint: created.requestFingerprint,
      responseSnapshot: first.response,
    });

    await expect(transferRegistration(
      "event-1",
      "registration-1",
      { ...transferInput, email: "different@example.test" },
      actor,
      now,
    )).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(store.tx.registration.update).toHaveBeenCalledOnce();
  });
});

describe("attendee substitution repository", () => {
  it("rejects checked-in attendees before changing a person or profile", async () => {
    const store = fixture();
    store.registration.attendees[0]!.checkIns.push({
      id: "check-in-1",
      checkedInAt: now,
    });

    await expect(substituteRegistrationAttendee(
      "event-1",
      "registration-1",
      "attendee-1",
      {
        ...transferInput,
        email: "replacement@example.test",
      },
      actor,
      now,
    )).rejects.toMatchObject({
      code: "ATTENDEE_CHECKED_IN",
    });
    expect(store.tx.registrationAttendee.update).not.toHaveBeenCalled();
    expect(store.tx.registrationOperation.create).not.toHaveBeenCalled();
  });

  it("rejects a replacement person already in the same party", async () => {
    const store = fixture();
    store.tx.person.findUnique.mockResolvedValueOnce({
      id: "person-attendee-2",
    } as never);

    await expect(substituteRegistrationAttendee(
      "event-1",
      "registration-1",
      "attendee-1",
      {
        ...transferInput,
        firstName: "Casey",
        lastName: "Guest",
        email: "casey@example.test",
      },
      actor,
      now,
    )).rejects.toMatchObject({
      code: "ATTENDEE_ALREADY_IN_PARTY",
    });
    expect(store.tx.registrationAttendee.update).not.toHaveBeenCalled();
  });

  it("updates identity in place while preserving attendee fields, capacity, and pricing", async () => {
    const store = fixture();
    const attendeeBefore = {
      id: store.registration.attendees[0]!.id,
      position: store.registration.attendees[0]!.position,
      attendeeType: store.registration.attendees[0]!.attendeeType,
      formResponses: store.registration.attendees[0]!.formResponses,
    };
    const capacityBefore = structuredClone(
      store.registration.capacityReservations,
    );
    const pricingBefore = structuredClone(
      store.registration.publicFormSubmission!.pricingSnapshot,
    );

    const result = await substituteRegistrationAttendee(
      "event-1",
      "registration-1",
      "attendee-1",
      {
        ...transferInput,
        firstName: "Riley",
        lastName: "Replacement",
        email: "riley@example.test",
      },
      actor,
      now,
    );

    expect(store.tx.registrationAttendee.update).toHaveBeenCalledWith({
      where: { id: "attendee-1" },
      data: {
        personId: "person-new",
        profileSnapshot: expect.objectContaining({
          firstName: "Riley",
          lastName: "Replacement",
          email: "riley@example.test",
          identityUpdatedBy: "STAFF_ATTENDEE_SUBSTITUTION",
          identityOperationId: expect.any(String),
        }),
      },
    });
    expect(store.registration.attendees[0]).toMatchObject(attendeeBefore);
    expect(store.registration.capacityReservations).toEqual(capacityBefore);
    expect(store.registration.publicFormSubmission!.pricingSnapshot)
      .toEqual(pricingBefore);
    expect(store.tx.registration.update).not.toHaveBeenCalled();
    expect(store.tx.registrationAccessToken.updateMany).not.toHaveBeenCalled();
    expect(result.response.operation.type).toBe("ATTENDEE_SUBSTITUTION");
    expect(messageMocks.enqueueAttendeeSubstitutedMessage)
      .toHaveBeenCalledTimes(3);
    expect(JSON.stringify(store.createdOperations[0]))
      .not.toMatch(/tokenHash|private-secret/);
  });
});
