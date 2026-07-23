import { beforeEach, describe, expect, it, vi } from "vitest";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
  enqueuePublicRegistrationMessages: vi.fn(),
  enqueueWaitlistJoinedMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit: dependencies.processQueuedMessageIdsAfterCommit,
  enqueuePublicRegistrationMessages: dependencies.enqueuePublicRegistrationMessages,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueWaitlistJoinedMessage: dependencies.enqueueWaitlistJoinedMessage,
}));

import { submitPublicRegistration } from "@/modules/forms/public-repository";

const definition = registrationFormDefinitionSchema.parse({
  title: "Waitlist transaction verification",
  description: "Fictitious registration used by the waitlist transaction test.",
  confirmationMessage: "This normal registration would be confirmed.",
  payment: {
    enabled: true,
    currency: "USD",
    paymentMethodFieldKey: "payment_method",
    cardOptionValue: "Credit / debit card",
    percentageBasisPoints: 290,
    fixedFeeCents: 30,
    passFeeToRegistrant: true,
  },
  sections: [{
    id: "contact",
    title: "Contact",
    description: "",
    fields: [
      { id: "first", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { id: "last", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { id: "email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
      { id: "room", key: "room", label: "Room", helpText: "", type: "RADIO", scope: "REGISTRATION", required: true, options: ["Cabin", "Commuting"], availabilityMode: "CAPACITY", choiceLimits: { Cabin: 1 } },
      { id: "fee", key: "registration_fee", label: "Registration fee", helpText: "", type: "CALCULATED", scope: "REGISTRATION", required: false, options: [], priceCents: 10000 },
      { id: "payment", key: "payment_method", label: "Payment method", helpText: "", type: "RADIO", scope: "REGISTRATION", required: true, options: ["Pay later", "Credit / debit card"] },
    ],
  }],
});

const input = publicRegistrationInputSchema.parse({
  versionId: "version-1",
  idempotencyKey: "b64a0acb-3711-48c2-ab8c-cdae084857eb",
  responses: {
    first_name: "Waitlist",
    last_name: "Tester",
    email: "waitlist.tester@example.test",
    room: "Cabin",
    payment_method: "Credit / debit card",
  },
  website: "",
});

function transactionFixture() {
  const tx = {
    registrationForm: {
      findFirst: vi.fn().mockResolvedValue({
        id: "form-1",
        slug: "attendee",
        eventId: "event-1",
        event: {
          id: "event-1",
          name: "Summer Retreat",
          slug: "summer-retreat",
          startsAt: new Date("2026-08-20T14:00:00.000Z"),
          endsAt: new Date("2026-08-22T18:00:00.000Z"),
          timezone: "America/Chicago",
          location: "Test venue",
          capacity: 1,
          isPublished: true,
          registrationOpensOn: "2026-08-01",
          registrationClosesOn: "2026-08-19",
          waitlistEnabled: true,
        },
        versions: [{
          id: "version-1",
          versionNumber: 1,
          definition,
          publishedAt: new Date("2026-07-01T12:00:00.000Z"),
        }],
      }),
    },
    publicRegistrationSubmission: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "submission-1" }),
    },
    registrationCapacityReservation: {
      findMany: vi.fn().mockResolvedValue([
        { fieldId: "room", optionValue: "Cabin", rank: null },
      ]),
      createMany: vi.fn(),
    },
    registrationAttendee: {
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue({ id: "attendee-1" }),
    },
    person: {
      upsert: vi.fn().mockResolvedValue({
        id: "person-1",
        firstName: "Waitlist",
        lastName: "Tester",
        normalizedEmail: "waitlist.tester@example.test",
      }),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    registration: {
      create: vi.fn().mockResolvedValue({ id: "registration-1" }),
      findUnique: vi.fn().mockResolvedValue({
        eventId: "event-1",
        confirmationCode: "REG-WAITLIST",
        event: { endsAt: new Date("2026-08-22T18:00:00.000Z") },
      }),
    },
    registrationAccessToken: {
      create: vi.fn().mockResolvedValue({ id: "access-1" }),
    },
    registrationWaitlistEntry: {
      aggregate: vi.fn().mockResolvedValue({ _max: { position: null } }),
      create: vi.fn().mockResolvedValue({ id: "waitlist-1" }),
    },
    messageOutbox: {
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  return { prisma, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.processQueuedMessageIdsAfterCommit.mockResolvedValue({
    capturedIds: [],
    sentIds: [],
    failedIds: [],
    rescheduledIds: [],
    skippedIds: [],
  });
  dependencies.enqueueWaitlistJoinedMessage.mockResolvedValue({
    messageIds: ["waitlist-message"],
    pendingMessageIds: ["waitlist-message"],
    deliveryMode: "LOCAL_CAPTURE",
    skippedReason: null,
  });
});

describe("public event waitlist transaction", () => {
  it("decides event waitlisting before full-choice validation and creates no option or payment claim", async () => {
    const { prisma, tx } = transactionFixture();
    dependencies.getPrisma.mockReturnValue(prisma);

    const confirmation = await submitPublicRegistration(
      "summer-retreat",
      "attendee",
      input,
      new Date("2026-08-10T12:00:00.000Z"),
    );

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.registration.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "WAITLISTED",
        totalAmount: 100,
      }),
    });
    expect(tx.registrationWaitlistEntry.create).toHaveBeenCalledWith({
      data: {
        eventId: "event-1",
        registrationId: "registration-1",
        position: 1,
        attendeeCount: 1,
      },
    });
    expect(tx.registrationCapacityReservation.findMany).not.toHaveBeenCalled();
    expect(tx.registrationCapacityReservation.createMany).not.toHaveBeenCalled();
    expect(tx.publicRegistrationSubmission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        responses: expect.not.objectContaining({
          payment_method: expect.anything(),
        }),
        pricingSnapshot: expect.objectContaining({
          subtotalCents: 10_000,
          processingFeeCents: 0,
          totalCents: 10_000,
          cardSelected: false,
          paymentEligible: false,
        }),
      }),
    });
    expect(dependencies.enqueuePublicRegistrationMessages).not.toHaveBeenCalled();
    expect(dependencies.enqueueWaitlistJoinedMessage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventId: "event-1",
        registrationId: "registration-1",
        recipientEmail: "waitlist.tester@example.test",
        recipientName: "Waitlist Tester",
        waitlistPosition: 1,
      }),
    );
    expect(dependencies.processQueuedMessageIdsAfterCommit).toHaveBeenCalledWith(
      ["waitlist-message"],
    );
    expect(confirmation).toMatchObject({
      registrationStatus: "WAITLISTED",
      capacityDecision: "WAITLIST",
      paymentEligible: false,
      paymentCollected: false,
      cardSelected: false,
      processingFeeCents: 0,
      totalCents: 10000,
      waitlistPosition: 1,
    });
  });
});
