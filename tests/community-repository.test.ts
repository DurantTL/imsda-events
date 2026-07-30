import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findSettings: vi.fn(),
  upsertSettings: vi.fn(),
  createAudit: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    eventCommunitySettings: {
      findUnique: mocks.findSettings,
    },
    $transaction: mocks.transaction,
  }),
}));

vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({
  matchingRegistrationIdsForVerifiedEmail: vi.fn(),
}));

import { updateCommunitySettings } from "@/modules/community/repository";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSettings.mockResolvedValue(null);
  mocks.upsertSettings.mockResolvedValue({
    id: "community-settings-1",
    isEnabled: true,
    allowNewPosts: true,
    allowReplies: true,
    conductVersion: 1,
    retentionDays: 30,
  });
  mocks.createAudit.mockResolvedValue({});
  mocks.transaction.mockImplementation(async (run) => run({
    eventCommunitySettings: { upsert: mocks.upsertSettings },
    auditLog: { create: mocks.createAudit },
  }));
});

describe("community settings repository", () => {
  it("does not spread the route action discriminator into Prisma data", async () => {
    const routeInput = {
      action: "UPDATE_SETTINGS" as const,
      isEnabled: true,
      allowNewPosts: true,
      allowReplies: true,
      conductText: "Be kind, protect privacy, and keep this discussion focused on the event.",
      retentionDays: 30,
    };
    await updateCommunitySettings(
      "event-1",
      "staff-1",
      routeInput,
    );

    expect(mocks.upsertSettings).toHaveBeenCalledWith({
      where: { eventId: "event-1" },
      create: {
        eventId: "event-1",
        updatedByUserId: "staff-1",
        isEnabled: true,
        allowNewPosts: true,
        allowReplies: true,
        conductText: "Be kind, protect privacy, and keep this discussion focused on the event.",
        retentionDays: 30,
      },
      update: {
        isEnabled: true,
        allowNewPosts: true,
        allowReplies: true,
        conductText: "Be kind, protect privacy, and keep this discussion focused on the event.",
        retentionDays: 30,
        updatedByUserId: "staff-1",
      },
    });
  });
});
