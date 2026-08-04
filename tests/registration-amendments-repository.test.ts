import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getRegistrationByIdWithClient: vi.fn(),
  enqueueRegistrationUpdatedMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/registrations/repository", () => ({
  getRegistrationByIdWithClient: dependencies.getRegistrationByIdWithClient,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueRegistrationUpdatedMessage: dependencies.enqueueRegistrationUpdatedMessage,
}));

import {
  amendRegistration,
  previewRegistrationAmendment,
} from "@/modules/registrations/amendments-repository";

const actor = { id: "user-1", displayName: "Staff User" };
const initialUpdatedAt = new Date("2026-08-04T12:00:00.000Z");
const definition = {
  title: "Amendment test form",
  description: "",
  confirmationMessage: "Registration received.",
  attendeeRoster: {
    enabled: true,
    minAttendees: 1,
    maxAttendees: 4,
    attendeeLabel: "Attendee",
    addButtonLabel: "Add attendee",
  },
  sections: [{
    id: "registration-fields",
    title: "Registration",
    description: "",
    fields: [
      {
        id: "contact-name-field",
        key: "primary_contact_name",
        label: "Contact name",
        helpText: "",
        type: "TEXT",
        scope: "REGISTRATION",
        required: true,
        options: [],
      },
      {
        id: "email-field",
        key: "email",
        label: "Email",
        helpText: "",
        type: "EMAIL",
        scope: "REGISTRATION",
        required: true,
        options: [],
      },
      {
        id: "lodging-field",
        key: "lodging",
        label: "Lodging",
        helpText: "",
        type: "RADIO",
        scope: "REGISTRATION",
        required: true,
        options: ["Cabin", "Commuting"],
      },
    ],
  }, {
    id: "attendee-fields",
    title: "Attendees",
    description: "",
    fields: [
      {
        id: "first-name-field",
        key: "first_name",
        label: "First name",
        helpText: "",
        type: "TEXT",
        scope: "ATTENDEE",
        required: true,
        options: [],
      },
      {
        id: "last-name-field",
        key: "last_name",
        label: "Last name",
        helpText: "",
        type: "TEXT",
        scope: "ATTENDEE",
        required: true,
        options: [],
      },
      {
        id: "meal-field",
        key: "meal",
        label: "Meal",
        helpText: "",
        type: "RADIO",
        scope: "ATTENDEE",
        required: true,
        options: ["Vegetarian", "Vegan"],
        availabilityMode: "CAPACITY",
        choiceLimits: { Vegetarian: 20, Vegan: 20 },
      },
      {
        id: "notes-field",
        key: "notes",
        label: "Notes",
        helpText: "",
        type: "TEXT",
        scope: "ATTENDEE",
        required: false,
        options: [],
      },
      {
        id: "seminar-field",
        key: "seminar_preferences",
        label: "Seminar preferences",
        helpText: "",
        type: "RANKED_CHOICE",
        scope: "ATTENDEE",
        required: true,
        options: ["Prayer", "Service"],
        minSelections: 2,
        maxSelections: 2,
        availabilityMode: "RANKED_INTEREST",
        choiceLimits: { Prayer: 1, Service: 1 },
      },
    ],
  }],
};

const registrationResponses = {
  primary_contact_name: "Taylor Contact",
  email: "taylor@example.test",
  lodging: "Cabin",
};
const attendeeResponses = {
  first_name: "Avery",
  last_name: "Guest",
  meal: "Vegetarian",
  notes: "Near the aisle",
  seminar_preferences: ["Prayer", "Service"],
};

function repositoryFixture() {
  const operations = new Map<string, Record<string, unknown>>();
  const registration = {
    id: "registration-1",
    eventId: "event-1",
    confirmationCode: "REG-123",
    status: "CONFIRMED",
    totalAmount: 0,
    updatedAt: initialUpdatedAt,
    event: {
      id: "event-1",
      name: "Test Event",
      timezone: "America/Chicago",
      capacity: 50,
    },
    accountHolderPerson: {
      id: "person-contact",
      firstName: "Taylor",
      lastName: "Contact",
      normalizedEmail: "taylor@example.test",
      phone: null,
    },
    publicFormSubmission: {
      formVersionId: "form-version-1",
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
      responses: { ...registrationResponses },
      pricingSnapshot: { totalCents: 0, pricingDate: "2026-08-01" },
      formVersion: {
        id: "form-version-1",
        versionNumber: 1,
        definition,
        form: { id: "form-1", name: "Test form", slug: "test-form" },
      },
    },
    attendees: [{
      id: "attendee-1",
      personId: "person-attendee",
      position: 0,
      attendeeType: "ATTENDEE",
      profileSnapshot: {
        firstName: "Avery",
        lastName: "Guest",
        email: null,
        phone: null,
      },
      formResponses: { ...attendeeResponses },
      person: {
        id: "person-attendee",
        firstName: "Avery",
        lastName: "Guest",
        normalizedEmail: null,
        phone: null,
      },
      checkIns: [],
      substitutionOperations: [],
    }],
    payments: [],
    capacityReservations: [{
      id: "reservation-1",
      registrationAttendeeId: "attendee-1",
      participantKey: "attendee:0",
      fieldId: "meal-field",
      fieldKey: "meal",
      optionValue: "Vegetarian",
      rank: null,
      releasedAt: null,
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
    }, {
      id: "reservation-2",
      registrationAttendeeId: "attendee-1",
      participantKey: "attendee:0",
      fieldId: "seminar-field",
      fieldKey: "seminar_preferences",
      optionValue: "Prayer",
      rank: 0,
      releasedAt: null,
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
    }, {
      id: "reservation-3",
      registrationAttendeeId: "attendee-1",
      participantKey: "attendee:0",
      fieldId: "seminar-field",
      fieldKey: "seminar_preferences",
      optionValue: "Service",
      rank: 1,
      releasedAt: null,
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
    }],
    promoCodeRedemption: null,
    operations: [] as Array<Record<string, unknown>>,
  };
  const tx = {
    registrationOperation: {
      findUnique: vi.fn(async ({ where }: { where: { eventId_clientRequestId: { clientRequestId: string } } }) => (
        operations.get(where.eventId_clientRequestId.clientRequestId) ?? null
      )),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        operations.set(String(data.clientRequestId), data);
        registration.operations.unshift({
          id: data.id,
          afterSnapshot: data.afterSnapshot,
          createdAt: data.createdAt,
        });
        return data;
      }),
    },
    registration: {
      findFirst: vi.fn(async () => structuredClone(registration)),
      update: vi.fn(async ({ data }: { data: { totalAmount: number } }) => {
        registration.totalAmount = data.totalAmount;
        registration.updatedAt = new Date("2026-08-04T13:00:00.000Z");
        return registration;
      }),
    },
    registrationAttendee: {
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async ({ where, data }: {
        where: { id: string };
        data: { position: number; attendeeType: string; profileSnapshot: Record<string, unknown>; formResponses: Record<string, unknown> };
      }) => {
        const attendee = registration.attendees.find((candidate) => candidate.id === where.id)!;
        Object.assign(attendee, data);
        return attendee;
      }),
      create: vi.fn(),
    },
    registrationCapacityReservation: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
        Object.assign(registration.capacityReservations[0], update);
        return registration.capacityReservations[0];
      }),
    },
    promoCodeRedemption: { update: vi.fn() },
    person: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  dependencies.getRegistrationByIdWithClient.mockImplementation(async () => ({
    id: registration.id,
    publicSubmission: {
      responses: registration.publicFormSubmission.responses,
      pricingSnapshot: registration.publicFormSubmission.pricingSnapshot,
    },
  }));
  return { registration, tx };
}

async function commitAmendment(
  clientRequestId: string,
  expectedUpdatedAt: string,
  responses: typeof attendeeResponses,
  now: Date,
) {
  const input = {
    clientRequestId,
    expectedUpdatedAt,
    reason: "Registrant requested the change.",
    responses: {
      lodging: registrationResponses.lodging,
      email: registrationResponses.email,
      primary_contact_name: registrationResponses.primary_contact_name,
    },
    attendees: [{
      attendeeId: "attendee-1",
      clientId: "attendee-row-1",
      responses,
    }],
    previewOnly: true,
  };
  const preview = await previewRegistrationAmendment(
    "event-1",
    "registration-1",
    input,
  );
  const committedInput = {
    ...input,
    previewOnly: false as const,
    quoteFingerprint: preview.quoteFingerprint,
  };
  const result = await amendRegistration(
    "event-1",
    "registration-1",
    committedInput,
    actor,
    now,
  );
  return { committedInput, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.enqueueRegistrationUpdatedMessage.mockResolvedValue({
    messageIds: ["message-1"],
    pendingMessageIds: ["message-1"],
    deliveryMode: "LOCAL_CAPTURE",
    skippedReason: null,
  });
});

describe("registration amendments repository", () => {
  it("enqueues one update for a real amendment and does not enqueue again on replay", async () => {
    repositoryFixture();
    const clientRequestId = "1616c563-e266-44b4-8c9a-d77e88ac3923";
    const changedResponses = { ...attendeeResponses, notes: "Near the front" };

    const amended = await commitAmendment(
      clientRequestId,
      initialUpdatedAt.toISOString(),
      changedResponses,
      new Date("2026-08-04T13:00:00.000Z"),
    );
    const replayed = await amendRegistration(
      "event-1",
      "registration-1",
      amended.committedInput,
      actor,
      new Date("2026-08-04T13:05:00.000Z"),
    );

    expect(amended.result.pendingMessageIds).toEqual(["message-1"]);
    expect(replayed.pendingMessageIds).toEqual(["message-1"]);
    expect(dependencies.enqueueRegistrationUpdatedMessage).toHaveBeenCalledOnce();
    expect(JSON.stringify(dependencies.enqueueRegistrationUpdatedMessage.mock.calls))
      .not.toContain("taylor@example.test");
    expect(JSON.stringify(dependencies.enqueueRegistrationUpdatedMessage.mock.calls))
      .not.toContain("Avery");
  });

  it("does not enqueue an update for an unchanged amendment", async () => {
    const { registration } = repositoryFixture();

    const { result } = await commitAmendment(
      "18bd6c4a-27cc-4ce5-a501-30325f293f88",
      registration.updatedAt.toISOString(),
      {
        notes: attendeeResponses.notes,
        meal: attendeeResponses.meal,
        last_name: attendeeResponses.last_name,
        first_name: attendeeResponses.first_name,
        seminar_preferences: attendeeResponses.seminar_preferences,
      },
      new Date("2026-08-04T13:00:00.000Z"),
    );

    expect(result.pendingMessageIds).toEqual([]);
    expect(dependencies.enqueueRegistrationUpdatedMessage).not.toHaveBeenCalled();
  });

  it("requires a reason and records a staff seminar override through the amendment path", async () => {
    const { registration, tx } = repositoryFixture();
    const input = {
      clientRequestId: "10ab0f4d-163f-4d3d-a842-e328665838ef",
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      reason: "",
      responses: { ...registrationResponses },
      attendees: [{
        attendeeId: "attendee-1",
        clientId: "attendee-row-1",
        responses: {
          ...attendeeResponses,
          seminar_preferences: ["Service", "Prayer"],
        },
      }],
      previewOnly: true as const,
    };

    await expect(previewRegistrationAmendment(
      "event-1",
      "registration-1",
      input,
    )).rejects.toThrow("Enter a reason for a staff seminar preference override.");

    const { result } = await commitAmendment(
      input.clientRequestId,
      input.expectedUpdatedAt,
      input.attendees[0].responses,
      new Date("2026-08-04T13:00:00.000Z"),
    );
    expect(result.registration.publicSubmission?.responses).toBeDefined();
    expect(dependencies.enqueueRegistrationUpdatedMessage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ changeCategory: "SEMINAR_PREFERENCES" }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: actor.id,
        correlationId: input.clientRequestId,
        metadata: expect.objectContaining({
          reason: "Registrant requested the change.",
          seminarPreferenceOverride: true,
        }),
      }),
    });
  });
});
