import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  processExternalEmailQueue: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/integrations/email/resend", () => ({
  getResendEmailAvailability: () => ({
    deliveryConfigured: true,
    webhookConfigured: true,
  }),
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  ExternalEmailDeliveryError: class ExternalEmailDeliveryError extends Error {},
  processExternalEmailQueue: mocks.processExternalEmailQueue,
}));

import { ensureEventMessagingDefaults } from "@/modules/communications/messaging-repository";

function harness(platform: Record<string, unknown> | null) {
  const tx = {
    eventMessageSettings: { upsert: vi.fn().mockResolvedValue({}) },
    eventMessageTemplate: {
      upsert: vi.fn().mockResolvedValue({ id: "template-1", versions: [{ id: "version-1" }] }),
    },
    messageTemplateVersion: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    platformSettings: { findUnique: vi.fn().mockResolvedValue(platform) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return { tx, prisma };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("new event messaging defaults", () => {
  it("inherits the platform sender identity when the row is created", async () => {
    const { tx } = harness({
      defaultSenderName: "IMSDA Events",
      defaultSenderEmail: "notifications@imsda.org",
      defaultReplyToEmail: "registration@imsda.org",
    });

    await ensureEventMessagingDefaults("event-1");

    expect(tx.eventMessageSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId: "event-1" },
      create: expect.objectContaining({
        senderName: "IMSDA Events",
        senderEmail: "notifications@imsda.org",
        replyToEmail: "registration@imsda.org",
      }),
    }));
  });

  it("still starts on local capture, so a new event cannot mail anyone unreviewed", async () => {
    const { tx } = harness({
      defaultSenderName: "IMSDA Events",
      defaultSenderEmail: "notifications@imsda.org",
      defaultReplyToEmail: "registration@imsda.org",
    });

    await ensureEventMessagingDefaults("event-1");

    // Inheriting an address is a convenience. Inheriting live delivery would
    // let a newly created event send before anyone reviewed a template.
    expect(tx.eventMessageSettings.upsert.mock.calls[0]?.[0].create.deliveryMode)
      .toBe("LOCAL_CAPTURE");
  });

  it("never rewrites an event whose settings already exist", async () => {
    const { tx } = harness({
      defaultSenderName: "IMSDA Events",
      defaultSenderEmail: "notifications@imsda.org",
      defaultReplyToEmail: "registration@imsda.org",
    });

    await ensureEventMessagingDefaults("event-1");

    // An empty update is what makes this safe: a staff member who chose a
    // sender for their event keeps it when the platform default changes later.
    expect(tx.eventMessageSettings.upsert.mock.calls[0]?.[0].update).toEqual({});
  });

  it("falls back to the built-in name when no platform row exists yet", async () => {
    const { tx } = harness(null);

    await ensureEventMessagingDefaults("event-1");

    expect(tx.eventMessageSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        senderName: "IMSDA Events",
        senderEmail: null,
        replyToEmail: null,
        deliveryMode: "LOCAL_CAPTURE",
      }),
    }));
  });
});
