import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGE_TEMPLATES } from "@/modules/communications/templates";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  processExternalEmailQueue: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: mocks.getPrisma,
}));
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
  enqueueShirtSizeRequestBatch,
  getShirtSizeRequestPreview,
} from "@/modules/communications/messaging-repository";
import { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";

const event = {
  id: "event-1",
  name: "Women’s Retreat",
  slug: "womens-retreat-2026",
  collectsShirtSizes: true,
  startsAt: new Date("2026-10-09T21:00:00.000Z"),
  endsAt: new Date("2026-10-11T17:00:00.000Z"),
  timezone: "America/Chicago",
  location: "Camp Heritage",
  supportContact: "help@example.test",
};

const settings = {
  deliveryMode: "EXTERNAL_EMAIL" as const,
  senderName: "IMSDA Events",
  senderEmail: "registration@example.test",
  replyToEmail: "help@example.test",
  internalNotificationEmails: [],
};

/** One registration, two attendees, only one of whom has answered. */
function partlyAnsweredRegistration() {
  return {
    id: "registration-1",
    confirmationCode: "WR26-ONE",
    status: "CONFIRMED",
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
    attendees: [
      {
        id: "attendee-1",
        formResponses: { shirt_size: "Adult L" },
        person: { firstName: "Casey", lastName: "Nguyen" },
      },
      {
        id: "attendee-2",
        formResponses: {},
        person: { firstName: "Blake", lastName: "Johnson" },
      },
    ],
  };
}

function baseTransaction() {
  return {
    // Read when event messaging settings are first created, so a new event
    // inherits the platform sender identity. Null here keeps these cases on the
    // built-in fallback, which is what they were written against.
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
        id: "template-shirt",
        key: "SHIRT_SIZE_REQUEST",
        isEnabled: true,
        versions: [{
          id: "version-shirt-1",
          versionNumber: 1,
          subjectTemplate: DEFAULT_MESSAGE_TEMPLATES.SHIRT_SIZE_REQUEST.subject,
          bodyTemplate: DEFAULT_MESSAGE_TEMPLATES.SHIRT_SIZE_REQUEST.body,
        }],
      }),
    },
    messageTemplateVersion: { create: vi.fn() },
    event: {
      findUnique: vi.fn().mockResolvedValue(event),
    },
    registration: {
      findMany: vi.fn().mockResolvedValue([partlyAnsweredRegistration()]),
    },
    auditLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    messageOutbox: {
      upsert: vi.fn().mockResolvedValue({
        id: "message-shirt-1",
        status: "PENDING",
      }),
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

describe("shirt-size request repository", () => {
  it("asks only about the attendee still missing a size, and does not send", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getShirtSizeRequestPreview("event-1");

    expect(preview).toMatchObject({
      includedCount: 1,
      missingAttendeeCount: 1,
    });
    expect(preview.recipients[0]?.missingAttendeeNames).toEqual(["Blake Johnson"]);

    const result = await enqueueShirtSizeRequestBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: "7d27bacc-90c3-4e74-884e-8aa36c673492",
    }, "user-1");

    expect(result).toMatchObject({
      includedCount: 1,
      missingAttendeeCount: 1,
      queuedCount: 1,
      capturedCount: 0,
      suppressedCount: 0,
      replayed: false,
    });

    const upsert = tx.messageOutbox.upsert.mock.calls[0]?.[0];
    expect(upsert).toMatchObject({
      where: {
        idempotencyKey: "shirt-size-request:event-1:7d27bacc-90c3-4e74-884e-8aa36c673492:registration-1",
      },
      create: expect.objectContaining({
        recipientEmail: "avery@example.test",
        templateKey: "SHIRT_SIZE_REQUEST",
        status: "PENDING",
      }),
    });
    // The attendee who already answered must not appear in the body, or a
    // registrant who partly answered is asked to redo work they finished.
    expect(upsert.create.bodyTextSnapshot).toContain("Blake Johnson");
    expect(upsert.create.bodyTextSnapshot).not.toContain("Casey Nguyen");
    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
  });

  it("carries the manage-link sentinel rather than a rendered URL", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getShirtSizeRequestPreview("event-1");

    await enqueueShirtSizeRequestBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: "1f9f4e07-0d43-4b57-9d0f-3a3d6a2c4b11",
    }, "user-1");

    const body = tx.messageOutbox.upsert.mock.calls[0]?.[0].create.bodyTextSnapshot as string;
    // Delivery swaps this for a freshly issued private link. Storing a real URL
    // here would hand every replay the same token.
    expect(body).toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
    expect(body).not.toContain("{{portal_url}}");
  });

  it("refuses a batch built from a preview that no longer matches", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(enqueueShirtSizeRequestBatch("event-1", {
      previewFingerprint: "c".repeat(64),
      batchId: "2c6a1f3e-5b7d-4a91-8f22-9e0b5d4c7a13",
    }, "user-1")).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });

    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
  });

  it("stops when every attendee already has a size", async () => {
    const tx = baseTransaction();
    const answered = partlyAnsweredRegistration();
    answered.attendees[1].formResponses = { shirt_size: "Adult M" };
    tx.registration.findMany.mockResolvedValue([answered]);
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    const preview = await getShirtSizeRequestPreview("event-1");
    expect(preview.includedCount).toBe(0);

    await expect(enqueueShirtSizeRequestBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: "3d7b2a4f-6c8e-4b02-9a33-0f1c6e5d8b24",
    }, "user-1")).rejects.toMatchObject({ code: "EMPTY_AUDIENCE" });
  });

  it("refuses an event that does not collect shirts, even with people missing sizes", async () => {
    const tx = baseTransaction();
    // Same registrations, same missing sizes. The event simply does not collect
    // shirts — which is now a stored capability, not a guess from its name.
    tx.event.findUnique.mockResolvedValue({
      ...event,
      name: "Men’s Convention",
      slug: "mens-convention-2027",
      collectsShirtSizes: false,
    });
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    const preview = await getShirtSizeRequestPreview("event-1");
    expect(preview.eventSupportsShirtSizes).toBe(false);
    // The registrant's picker is gated on the same predicate, so asking would
    // send them to a page that refuses the answer.
    expect(preview.includedCount).toBe(0);

    await expect(enqueueShirtSizeRequestBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: "5f9d4c6b-8e0a-4d24-9c55-2b3e8a7f0d46",
    }, "user-1")).rejects.toMatchObject({ code: "EVENT_NOT_ELIGIBLE" });

    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
  });

  it("keeps collecting sizes when the event is renamed", async () => {
    const tx = baseTransaction();
    // The rule this replaced read the event's name, so renaming an event
    // silently stopped it collecting sizes. A stored capability survives it.
    tx.event.findUnique.mockResolvedValue({
      ...event,
      name: "Autumn Gathering",
      slug: "autumn-gathering-2026",
      collectsShirtSizes: true,
    });
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    const preview = await getShirtSizeRequestPreview("event-1");
    expect(preview.eventSupportsShirtSizes).toBe(true);
    expect(preview.includedCount).toBe(1);
  });

  it("invalidates a reviewed batch when shirt collection is switched off mid-review", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getShirtSizeRequestPreview("event-1");
    expect(preview.eventSupportsShirtSizes).toBe(true);

    // Turned off between review and send. Eligibility sits inside the
    // fingerprint, so the reviewed batch must not still be sendable.
    tx.event.findUnique.mockResolvedValue({ ...event, collectsShirtSizes: false });

    await expect(enqueueShirtSizeRequestBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: "6a0e5d7c-9f1b-4e35-8d66-3c4f9b8e1e57",
    }, "user-1")).rejects.toMatchObject({ code: "EVENT_NOT_ELIGIBLE" });
  });

  it("replays an audited batch before recomputing, and rejects reuse with another fingerprint", async () => {
    const tx = baseTransaction();
    tx.auditLog.findFirst.mockResolvedValue({
      metadata: {
        previewFingerprint: "a".repeat(64),
        includedCount: 1,
        missingAttendeeCount: 1,
        deliveryMode: "EXTERNAL_EMAIL",
        initialQueuedCount: 1,
        initialSuppressedCount: 0,
      },
    });
    tx.messageOutbox.findMany.mockResolvedValue([{
      id: "message-existing",
      status: "SENT",
    }]);
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(enqueueShirtSizeRequestBatch("event-1", {
      previewFingerprint: "a".repeat(64),
      batchId: "e19d35b0-fb62-44e0-a1e2-f11202ee15a0",
    }, "user-1")).resolves.toMatchObject({
      messageIds: ["message-existing"],
      queuedCount: 1,
      replayed: true,
    });
    // A replay must not recompute the audience: the point is to return the
    // batch that was already recorded, not a second one built from newer data.
    expect(tx.registration.findMany).not.toHaveBeenCalled();

    await expect(enqueueShirtSizeRequestBatch("event-1", {
      previewFingerprint: "b".repeat(64),
      batchId: "e19d35b0-fb62-44e0-a1e2-f11202ee15a0",
    }, "user-1")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("records suppressed rows instead of queueing when the template is disabled", async () => {
    const tx = baseTransaction();
    tx.eventMessageTemplate.findUnique.mockResolvedValue({
      id: "template-shirt",
      key: "SHIRT_SIZE_REQUEST",
      isEnabled: false,
      versions: [{
        id: "version-shirt-1",
        versionNumber: 1,
        subjectTemplate: DEFAULT_MESSAGE_TEMPLATES.SHIRT_SIZE_REQUEST.subject,
        bodyTemplate: DEFAULT_MESSAGE_TEMPLATES.SHIRT_SIZE_REQUEST.body,
      }],
    });
    tx.messageOutbox.upsert.mockResolvedValue({
      id: "message-shirt-1",
      status: "SUPPRESSED",
    });
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    const preview = await getShirtSizeRequestPreview("event-1");
    const result = await enqueueShirtSizeRequestBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: "4e8c3b5a-7d9f-4c13-8b44-1a2d7f6e9c35",
    }, "user-1");

    expect(result).toMatchObject({ queuedCount: 0, suppressedCount: 1 });
    expect(tx.messageOutbox.upsert.mock.calls[0]?.[0].create).toMatchObject({
      status: "SUPPRESSED",
      lastError: "The shirt size request template is disabled.",
    });
  });
});
