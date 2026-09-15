import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGE_TEMPLATES } from "@/modules/communications/templates";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  processExternalEmailQueue: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/integrations/email/resend", () => ({
  getResendEmailAvailability: () => ({
    deliveryConfigured: false,
    webhookConfigured: false,
  }),
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  ExternalEmailDeliveryError: class ExternalEmailDeliveryError extends Error {},
  processExternalEmailQueue: mocks.processExternalEmailQueue,
}));

import {
  enqueueSelectedAudienceBatch,
  getSelectedAudiencePreview,
} from "@/modules/communications/messaging-repository";

const batchId = "7d27bacc-90c3-4e74-884e-8aa36c673492";

const event = {
  id: "event-1",
  name: "Women’s Retreat",
  slug: "womens-retreat-2026",
  startsAt: new Date("2026-10-09T21:00:00.000Z"),
  endsAt: new Date("2026-10-11T17:00:00.000Z"),
  timezone: "America/Chicago",
  location: "Camp Heritage",
  supportContact: "help@example.test",
  billingMode: "ATTENDEE_PAY" as const,
  paymentInstructionVersions: [{ instructions: "Mail a check to the conference office." }],
  hotelName: null,
  hotelBookingUrl: null,
  hotelPhone: null,
  hotelGroupName: null,
  hotelRate: null,
  hotelInstructions: null,
};

const settings = {
  deliveryMode: "EXTERNAL_EMAIL" as const,
  senderName: "IMSDA Events",
  senderEmail: "registration@example.test",
  replyToEmail: "help@example.test",
  internalNotificationEmails: [],
};

function money(value: string) {
  return { toString: () => value };
}

function listedRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: "registration-1",
    confirmationCode: "REG-ONE",
    status: "CONFIRMED",
    totalAmount: money("200.00"),
    contactSnapshot: {
      firstName: "Avery",
      lastName: "Johnson",
      email: "AVERY@EXAMPLE.TEST",
    },
    accountHolderPerson: {
      firstName: "Canonical",
      lastName: "Person",
      normalizedEmail: "canonical@example.test",
    },
    payments: [{ amount: money("100.00"), refunds: [{ amount: money("25.00") }] }],
    ...overrides,
  };
}

function baseTransaction() {
  return {
    platformSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    eventMessageSettings: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(settings),
      findUniqueOrThrow: vi.fn().mockResolvedValue(settings),
    },
    eventMessageTemplate: {
      upsert: vi.fn().mockResolvedValue({
        id: "template-existing",
        versions: [{ id: "version-existing" }],
      }),
      findUnique: vi.fn().mockResolvedValue({
        id: "template-balance",
        key: "BALANCE_REMINDER",
        isEnabled: true,
        versions: [{
          id: "version-balance-1",
          versionNumber: 1,
          subjectTemplate: DEFAULT_MESSAGE_TEMPLATES.BALANCE_REMINDER.subject,
          bodyTemplate: DEFAULT_MESSAGE_TEMPLATES.BALANCE_REMINDER.body,
        }],
      }),
    },
    messageTemplateVersion: { create: vi.fn() },
    event: { findUnique: vi.fn().mockResolvedValue(event) },
    registration: {
      findMany: vi.fn().mockResolvedValue([listedRegistration()]),
      findFirst: vi.fn().mockResolvedValue({
        ...listedRegistration(),
        event,
        attendees: [{
          id: "attendee-1",
          profileSnapshot: { firstName: "Avery", lastName: "Johnson" },
          person: { firstName: "Avery", lastName: "Johnson" },
        }],
        waitlistEntry: null,
      }),
    },
    auditLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    messageOutbox: {
      upsert: vi.fn().mockResolvedValue({ id: "message-1", status: "PENDING" }),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };
}

function prismaFor(tx: ReturnType<typeof baseTransaction>) {
  return {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("selected-audience batch repository", () => {
  it("queues the reviewed audience and records the batch once", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getSelectedAudiencePreview(
      "event-1",
      "BALANCE_REMINDER",
      ["registration-1"],
    );

    const operation = await enqueueSelectedAudienceBatch("event-1", {
      batchId,
      templateKey: "BALANCE_REMINDER",
      registrationIds: ["registration-1"],
      announcementTitle: "",
      announcementBody: "",
      previewFingerprint: preview.fingerprint,
    }, "user-1");

    expect(operation).toMatchObject({
      includedCount: 1,
      skippedCount: 0,
      queuedCount: 1,
      suppressedCount: 0,
      replayed: false,
    });
    expect(tx.messageOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        recipientEmail: "avery@example.test",
        templateKey: "BALANCE_REMINDER",
        correlationId: batchId,
        status: "PENDING",
        metadata: expect.objectContaining({
          trigger: "STAFF_SELECTED_AUDIENCE_BATCH",
          batchId,
        }),
      }),
    }));
    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
  });

  it("reads only the chosen registrations, scoped to the event", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await getSelectedAudiencePreview("event-1", "BALANCE_REMINDER", ["registration-1"]);

    expect(tx.registration.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId: "event-1", id: { in: ["registration-1"] } },
    }));
  });

  it("refuses a send whose audience moved since it was reviewed", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(enqueueSelectedAudienceBatch("event-1", {
      batchId,
      templateKey: "BALANCE_REMINDER",
      registrationIds: ["registration-1"],
      announcementTitle: "",
      announcementBody: "",
      previewFingerprint: "b".repeat(64),
    }, "user-1")).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
  });

  it("refuses to send when nothing in the selection is eligible", async () => {
    const tx = baseTransaction();
    tx.registration.findMany.mockResolvedValue([
      listedRegistration({ payments: [{ amount: money("200.00"), refunds: [] }] }),
    ]);
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getSelectedAudiencePreview(
      "event-1",
      "BALANCE_REMINDER",
      ["registration-1"],
    );

    expect(preview.skipped[0].code).toBe("NO_BALANCE_DUE");
    await expect(enqueueSelectedAudienceBatch("event-1", {
      batchId,
      templateKey: "BALANCE_REMINDER",
      registrationIds: ["registration-1"],
      announcementTitle: "",
      announcementBody: "",
      previewFingerprint: preview.fingerprint,
    }, "user-1")).rejects.toMatchObject({ code: "EMPTY_AUDIENCE" });
  });

  it("returns the existing batch instead of sending a re-posted one twice", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getSelectedAudiencePreview(
      "event-1",
      "BALANCE_REMINDER",
      ["registration-1"],
    );
    tx.auditLog.findFirst.mockResolvedValue({
      metadata: {
        previewFingerprint: preview.fingerprint,
        includedCount: 1,
        skippedCount: 0,
        deliveryMode: "EXTERNAL_EMAIL",
      },
    });
    tx.messageOutbox.findMany.mockResolvedValue([{ id: "message-1", status: "PENDING" }]);

    const operation = await enqueueSelectedAudienceBatch("event-1", {
      batchId,
      templateKey: "BALANCE_REMINDER",
      registrationIds: ["registration-1"],
      announcementTitle: "",
      announcementBody: "",
      previewFingerprint: preview.fingerprint,
    }, "user-1");

    expect(operation.replayed).toBe(true);
    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
  });

  it("rejects a batch id replayed with a different audience", async () => {
    const tx = baseTransaction();
    tx.auditLog.findFirst.mockResolvedValue({
      metadata: { previewFingerprint: "c".repeat(64) },
    });
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(enqueueSelectedAudienceBatch("event-1", {
      batchId,
      templateKey: "BALANCE_REMINDER",
      registrationIds: ["registration-1"],
      announcementTitle: "",
      announcementBody: "",
      previewFingerprint: "d".repeat(64),
    }, "user-1")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
});
