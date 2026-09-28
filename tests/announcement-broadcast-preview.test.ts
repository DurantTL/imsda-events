import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  enqueueEventAnnouncementMessage: vi.fn(),
  ensureEventMessagingDefaults: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  ensureEventMessagingDefaults: mocks.ensureEventMessagingDefaults,
  processQueuedMessageIdsAfterCommit: mocks.processQueuedMessageIdsAfterCommit,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueEventAnnouncementMessage: mocks.enqueueEventAnnouncementMessage,
}));

import {
  AnnouncementBroadcastError,
  broadcastPublishedAnnouncement,
  previewAnnouncementBroadcast,
} from "@/modules/communications/announcement-broadcast";
import {
  announcementRecipientEmail,
  computeAnnouncementBroadcastPreview,
} from "@/modules/communications/announcement-broadcast-preview";

type SyntheticRegistration = {
  id: string;
  contactSnapshot: unknown;
  accountHolderPerson: { normalizedEmail: string | null };
};

const defaultRegistrations: SyntheticRegistration[] = [
  { id: "reg-1", contactSnapshot: { email: "one@example.test" }, accountHolderPerson: { normalizedEmail: "one@example.test" } },
  { id: "reg-2", contactSnapshot: { email: "Two@Example.test " }, accountHolderPerson: { normalizedEmail: null } },
  { id: "reg-3", contactSnapshot: {}, accountHolderPerson: { normalizedEmail: "three@example.test" } },
];

function prismaFor(overrides: {
  announcement?: Record<string, unknown> | null;
  registrations?: SyntheticRegistration[];
  deliveryMode?: string | null;
  template?: { isEnabled: boolean; versions: Array<{ id: string }> } | null;
  existingAudit?: { metadata: Record<string, unknown> } | null;
} = {}) {
  const client = {
    announcement: {
      findFirst: vi.fn().mockResolvedValue(
        overrides.announcement === undefined
          ? {
            id: "announcement-1",
            title: "Friday arrival information",
            body: "Doors open at 5 p.m.",
            status: "PUBLISHED",
            publishedAt: new Date("2026-09-20T00:00:00.000Z"),
          }
          : overrides.announcement,
      ),
    },
    registration: {
      findMany: vi.fn().mockResolvedValue(overrides.registrations ?? defaultRegistrations),
    },
    eventMessageSettings: {
      findUnique: vi.fn().mockResolvedValue(
        overrides.deliveryMode === undefined
          ? { deliveryMode: "LOCAL_CAPTURE" }
          : overrides.deliveryMode === null ? null : { deliveryMode: overrides.deliveryMode },
      ),
    },
    eventMessageTemplate: {
      findUnique: vi.fn().mockResolvedValue(
        overrides.template === undefined
          ? { isEnabled: true, versions: [{ id: "template-version-1" }] }
          : overrides.template,
      ),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(overrides.existingAudit ?? null),
    },
    messageOutbox: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "announcement-1" }]),
  };
  return {
    ...client,
    $transaction: vi.fn(async (callback: (tx: typeof client) => unknown) => callback(client)),
  };
}

/**
 * The review step's data source (#472): the recipient counts must match what
 * the send actually does, so a registration with no contact email counts as
 * skipped and a disabled template is reported as suppressed. It must never
 * touch the outbox or the audit log.
 */
describe("previewAnnouncementBroadcast (#472)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts every active registration with a contact email and reports the delivery mode", async () => {
    const prisma = prismaFor();
    mocks.getPrisma.mockReturnValue(prisma);

    const preview = await previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    });

    expect(mocks.ensureEventMessagingDefaults).toHaveBeenCalledWith("event-1");
    expect(prisma.registration.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId: "event-1", status: { in: ["SUBMITTED", "CONFIRMED"] } },
    }));
    expect(preview).toMatchObject({
      announcementId: "announcement-1",
      title: "Friday arrival information",
      audienceLabel: "All active registrations (submitted or confirmed) for this event",
      activeRegistrationCount: 3,
      recipientCount: 3,
      skippedNoEmailCount: 0,
      deliveryMode: "LOCAL_CAPTURE",
      templateEnabled: true,
      suppressed: false,
      sendTiming: "IMMEDIATE",
    });
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.enqueueEventAnnouncementMessage).not.toHaveBeenCalled();
  });

  it("skips a registration with no contact email, as the send does", async () => {
    const prisma = prismaFor({
      registrations: [
        ...defaultRegistrations,
        { id: "reg-4", contactSnapshot: { email: "   " }, accountHolderPerson: { normalizedEmail: null } },
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    const preview = await previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    });

    expect(preview.activeRegistrationCount).toBe(4);
    expect(preview.recipientCount).toBe(3);
    expect(preview.skippedNoEmailCount).toBe(1);
  });

  it("reports a disabled announcement template as suppressed", async () => {
    const prisma = prismaFor({ template: { isEnabled: false, versions: [{ id: "template-version-1" }] } });
    mocks.getPrisma.mockReturnValue(prisma);

    const preview = await previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    });

    expect(preview.templateEnabled).toBe(false);
    expect(preview.suppressed).toBe(true);
  });

  it("falls back to local capture when settings have never been created", async () => {
    const prisma = prismaFor({ deliveryMode: null });
    mocks.getPrisma.mockReturnValue(prisma);

    const preview = await previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    });

    expect(preview.deliveryMode).toBe("LOCAL_CAPTURE");
  });

  it("refuses to preview an announcement that no longer exists", async () => {
    mocks.getPrisma.mockReturnValue(prismaFor({ announcement: null }));

    await expect(previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "missing",
    })).rejects.toMatchObject({ code: "ANNOUNCEMENT_NOT_FOUND" });
  });

  it("refuses to preview a draft that hasn't been published to the feed yet", async () => {
    mocks.getPrisma.mockReturnValue(prismaFor({
      announcement: {
        id: "announcement-1",
        title: "Draft update",
        body: "Draft body",
        status: "DRAFT",
        publishedAt: null,
      },
    }));

    await expect(previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    })).rejects.toBeInstanceOf(AnnouncementBroadcastError);
  });
});

describe("computeAnnouncementBroadcastPreview fingerprint (#472)", () => {
  const context = {
    eventId: "event-1",
    announcement: { id: "announcement-1", title: "Friday arrival", body: "Doors open at 5." },
    deliveryMode: "LOCAL_CAPTURE" as const,
    templateEnabled: true,
    templateVersionId: "template-version-1",
  };
  const candidates = [
    { registrationId: "reg-2", contactSnapshot: { email: "two@example.test" }, accountHolderNormalizedEmail: null },
    { registrationId: "reg-1", contactSnapshot: { email: "one@example.test" }, accountHolderNormalizedEmail: null },
  ];

  it("is stable regardless of candidate order", () => {
    const a = computeAnnouncementBroadcastPreview(candidates, context);
    const b = computeAnnouncementBroadcastPreview([...candidates].reverse(), context);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("changes when the recipients, template state, or announcement change", () => {
    const base = computeAnnouncementBroadcastPreview(candidates, context).fingerprint;
    expect(computeAnnouncementBroadcastPreview(candidates.slice(0, 1), context).fingerprint).not.toBe(base);
    expect(computeAnnouncementBroadcastPreview(candidates, { ...context, templateEnabled: false }).fingerprint).not.toBe(base);
    expect(computeAnnouncementBroadcastPreview(candidates, {
      ...context,
      announcement: { ...context.announcement, id: "announcement-2" },
    }).fingerprint).not.toBe(base);
  });

  it("resolves the recipient email like the send: snapshot first, then account holder", () => {
    expect(announcementRecipientEmail({ email: " A@Example.test " }, "b@example.test")).toBe("a@example.test");
    expect(announcementRecipientEmail({ email: "" }, "b@example.test")).toBe("b@example.test");
    expect(announcementRecipientEmail(null, null)).toBe("");
  });
});

describe("broadcastPublishedAnnouncement review enforcement (#472)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueEventAnnouncementMessage.mockResolvedValue({
      messageIds: ["message-1"],
      pendingMessageIds: ["message-1"],
      deliveryMode: "LOCAL_CAPTURE",
      skippedReason: null,
    });
  });

  it("refuses a stale fingerprint without enqueueing anything", async () => {
    mocks.getPrisma.mockReturnValue(prismaFor());

    await expect(broadcastPublishedAnnouncement({
      eventId: "event-1",
      announcementId: "announcement-1",
      batchId: "2d037129-32a3-4935-a4ce-b08a1d92cb6a",
      previewFingerprint: "0".repeat(64),
      actorUserId: "staff-1",
    })).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
    expect(mocks.enqueueEventAnnouncementMessage).not.toHaveBeenCalled();
  });

  it("sends when the fingerprint matches the current review", async () => {
    const prisma = prismaFor();
    mocks.getPrisma.mockReturnValue(prisma);
    const preview = await previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    });

    const result = await broadcastPublishedAnnouncement({
      eventId: "event-1",
      announcementId: "announcement-1",
      batchId: "2d037129-32a3-4935-a4ce-b08a1d92cb6a",
      previewFingerprint: preview.fingerprint,
      actorUserId: "staff-1",
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueEventAnnouncementMessage).toHaveBeenCalledTimes(3);
    expect(result.messageCount).toBe(3);
    expect(result.replayed).toBe(false);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("sends exactly the reviewed recipients, each with its reviewed email", async () => {
    const prisma = prismaFor({
      registrations: [
        ...defaultRegistrations,
        { id: "reg-4", contactSnapshot: {}, accountHolderPerson: { normalizedEmail: null } },
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);
    const preview = await previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    });

    const result = await broadcastPublishedAnnouncement({
      eventId: "event-1",
      announcementId: "announcement-1",
      batchId: "2d037129-32a3-4935-a4ce-b08a1d92cb6a",
      previewFingerprint: preview.fingerprint,
      actorUserId: "staff-1",
    });

    const sent = mocks.enqueueEventAnnouncementMessage.mock.calls.map(
      ([, call]) => [call.registrationId, call.recipientEmail],
    );
    expect(sent).toEqual([
      ["reg-1", "one@example.test"],
      ["reg-2", "two@example.test"],
      ["reg-3", "three@example.test"],
    ]);
    expect(result.skippedCount).toBe(1);
  });
});

describe("broadcastPublishedAnnouncement replay (#472)", () => {
  const batchId = "2d037129-32a3-4935-a4ce-b08a1d92cb6a";
  const storedAudit = {
    metadata: {
      announcementId: "announcement-1",
      batchId,
      previewFingerprint: "c".repeat(64),
      messageCount: 3,
      skippedCount: 0,
      deliveryMode: "LOCAL_CAPTURE",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the stored result for a batch that already committed, unchanged audience", async () => {
    const prisma = prismaFor({ existingAudit: storedAudit });
    mocks.getPrisma.mockReturnValue(prisma);

    const result = await broadcastPublishedAnnouncement({
      eventId: "event-1",
      announcementId: "announcement-1",
      batchId,
      previewFingerprint: "c".repeat(64),
      actorUserId: "staff-1",
    });

    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        eventId: "event-1",
        action: "EVENT_ANNOUNCEMENT_BROADCAST_ENQUEUED",
        entityId: "announcement-1",
        correlationId: batchId,
      },
    }));
    expect(result).toMatchObject({ messageCount: 3, skippedCount: 0, deliveryMode: "LOCAL_CAPTURE", replayed: true });
    expect(mocks.enqueueEventAnnouncementMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("still replays (no 409, no second send) when the audience changed after the send", async () => {
    const prisma = prismaFor({
      existingAudit: storedAudit,
      registrations: [
        ...defaultRegistrations,
        { id: "reg-5", contactSnapshot: { email: "five@example.test" }, accountHolderPerson: { normalizedEmail: null } },
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    const result = await broadcastPublishedAnnouncement({
      eventId: "event-1",
      announcementId: "announcement-1",
      batchId,
      // Stale against the grown audience, but the batch already went out.
      previewFingerprint: "c".repeat(64),
      actorUserId: "staff-1",
    });

    expect(result).toMatchObject({ messageCount: 3, replayed: true });
    expect(prisma.registration.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueueEventAnnouncementMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses to send when no active registration has a contact email", async () => {
    const prisma = prismaFor({
      registrations: [
        { id: "reg-9", contactSnapshot: {}, accountHolderPerson: { normalizedEmail: null } },
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);
    const preview = await previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    });
    expect(preview.recipientCount).toBe(0);

    await expect(broadcastPublishedAnnouncement({
      eventId: "event-1",
      announcementId: "announcement-1",
      batchId: "2d037129-32a3-4935-a4ce-b08a1d92cb6a",
      previewFingerprint: preview.fingerprint,
      actorUserId: "staff-1",
    })).rejects.toMatchObject({ code: "NO_ACTIVE_REGISTRATIONS" });
    expect(mocks.enqueueEventAnnouncementMessage).not.toHaveBeenCalled();
  });
});
