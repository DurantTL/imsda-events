import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  ensureEventMessagingDefaults: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueEventAnnouncementMessage: vi.fn(),
}));

import {
  AnnouncementBroadcastError,
  previewAnnouncementBroadcast,
} from "@/modules/communications/announcement-broadcast";

function prismaFor(overrides: {
  announcement?: Record<string, unknown> | null;
  recipientCount?: number;
  deliveryMode?: string | null;
}) {
  return {
    announcement: {
      findFirst: vi.fn().mockResolvedValue(
        overrides.announcement === undefined
          ? {
            id: "announcement-1",
            title: "Friday arrival information",
            status: "PUBLISHED",
            publishedAt: new Date("2026-09-20T00:00:00.000Z"),
          }
          : overrides.announcement,
      ),
    },
    registration: {
      count: vi.fn().mockResolvedValue(overrides.recipientCount ?? 3),
    },
    eventMessageSettings: {
      findUnique: vi.fn().mockResolvedValue(
        overrides.deliveryMode === undefined
          ? { deliveryMode: "LOCAL_CAPTURE" }
          : overrides.deliveryMode === null ? null : { deliveryMode: overrides.deliveryMode },
      ),
    },
  };
}

/**
 * The review step's data source (#472): before the send button in the
 * dialog is ever enabled, this is what the recipient count, audience, and
 * delivery mode on screen come from. It must never touch the outbox or the
 * audit log — that's `broadcastPublishedAnnouncement`'s job, tested
 * separately by the route test.
 */
describe("previewAnnouncementBroadcast (#472)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the active-registration count, fixed audience, and current delivery mode", async () => {
    const prisma = prismaFor({});
    mocks.getPrisma.mockReturnValue(prisma);

    const preview = await previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    });

    expect(prisma.registration.count).toHaveBeenCalledWith({
      where: { eventId: "event-1", status: { in: ["SUBMITTED", "CONFIRMED"] } },
    });
    expect(preview).toMatchObject({
      announcementId: "announcement-1",
      title: "Friday arrival information",
      audienceLabel: "All active registrations (submitted or confirmed) for this event",
      recipientCount: 3,
      deliveryMode: "LOCAL_CAPTURE",
      sendTiming: "IMMEDIATE",
    });
    expect(typeof preview.generatedAt).toBe("string");
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
    const prisma = prismaFor({ announcement: null });
    mocks.getPrisma.mockReturnValue(prisma);

    await expect(previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "missing",
    })).rejects.toMatchObject({
      code: "ANNOUNCEMENT_NOT_FOUND",
    });
  });

  it("refuses to preview a draft that hasn't been published to the feed yet", async () => {
    const prisma = prismaFor({
      announcement: {
        id: "announcement-1",
        title: "Draft update",
        status: "DRAFT",
        publishedAt: null,
      },
    });
    mocks.getPrisma.mockReturnValue(prisma);

    await expect(previewAnnouncementBroadcast({
      eventId: "event-1",
      announcementId: "announcement-1",
    })).rejects.toBeInstanceOf(AnnouncementBroadcastError);
  });
});
