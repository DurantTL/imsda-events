import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  EventOperationError,
  publishEvent,
  unpublishEvent,
  updateEventSettings,
} from "@/modules/events/repository";

const baseInput = {
  name: "Synthetic Retreat",
  slug: "synthetic-retreat",
  startsOn: "2027-10-08",
  endsOn: "2027-10-10",
  timezone: "America/Chicago" as const,
  location: "Camp Heritage",
  capacity: 350,
  publicInfoUrl: null,
  supportContact: "registration@imsda.org",
  hotelName: undefined,
  hotelBookingUrl: undefined,
  hotelPhone: undefined,
  hotelGroupName: undefined,
  hotelRate: undefined,
  hotelInstructions: undefined,
  approvedPaymentInstructions: undefined,
  isPublished: true,
  registrationOpensOn: "2027-05-01",
  registrationClosesOn: "2027-10-01",
  collectsShirtSizes: false,
  checksAdultBackgrounds: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT" as const,
  billingMode: "ATTENDEE_PAY" as const,
  seminarPreferenceClosesOn: null,
  seminarPreferenceSelfServiceLocked: false,
  waitlistEnabled: true,
  autoPromoteWaitlist: true,
};

const eventRow = (overrides: Partial<{ isPublished: boolean; publicInfoUrl: string | null }> = {}) => ({
  name: "Synthetic Retreat",
  slug: "synthetic-retreat",
  startsAt: new Date("2027-10-08T12:00:00.000Z"),
  endsAt: new Date("2027-10-10T12:00:00.000Z"),
  timezone: "America/Chicago",
  location: "Camp Heritage",
  capacity: 350,
  publicInfoUrl: overrides.publicInfoUrl ?? null,
  supportContact: "registration@imsda.org",
  hotelName: null,
  hotelBookingUrl: null,
  hotelPhone: null,
  hotelGroupName: null,
  hotelRate: null,
  hotelInstructions: null,
  isPublished: overrides.isPublished ?? false,
  registrationOpensOn: "2027-05-01",
  registrationClosesOn: "2027-10-01",
  waitlistEnabled: true,
  collectsShirtSizes: false,
  checksAdultBackgrounds: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT",
  billingMode: "ATTENDEE_PAY",
  seminarPreferenceClosesOn: null,
  seminarPreferenceSelfServiceLocked: false,
  autoPromoteWaitlist: true,
});

/**
 * Mocks what each repository function actually reads/writes through
 * `$transaction`, mirroring the pattern `tests/event-overview-church-billed.test.ts`
 * uses for another repository function in this module. `afterIsPublished`
 * is what `getEventSettings`'s own re-read (via `prisma.event.findUnique`,
 * not the transaction client) should report once the write commits.
 */
function mockPrisma(current: { isPublished: boolean; publicInfoUrl?: string | null }, publishedFormCount: number, afterIsPublished?: boolean) {
  const eventUpdate = vi.fn().mockResolvedValue({});
  const auditLogCreate = vi.fn().mockResolvedValue({});
  const tx = {
    event: {
      findUnique: vi.fn().mockResolvedValue(eventRow(current)),
      update: eventUpdate,
    },
    registrationFormVersion: {
      count: vi.fn().mockResolvedValue(publishedFormCount),
    },
    eventPaymentInstructionVersion: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: { create: auditLogCreate },
  };
  const prisma = {
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    event: {
      findUnique: vi.fn().mockResolvedValue({
        id: "event-1",
        ...eventRow({ ...current, isPublished: afterIsPublished ?? current.isPublished }),
        createdAt: new Date("2027-01-01T00:00:00.000Z"),
        updatedAt: new Date("2027-01-01T00:00:00.000Z"),
      }),
    },
    registrationForm: { findMany: vi.fn().mockResolvedValue([]) },
    eventPaymentInstructionVersion: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return { prisma, tx, eventUpdate, auditLogCreate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("event settings save never changes publish state (#471)", () => {
  it("keeps the event unpublished even when the saved input asks to publish it", async () => {
    const { prisma, eventUpdate, auditLogCreate } = mockPrisma({ isPublished: false, publicInfoUrl: null }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await updateEventSettings("event-1", { ...baseInput, isPublished: true }, "usr_1");

    expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isPublished: false }),
    }));
    expect(result?.isPublished).toBe(false);
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_SETTINGS_UPDATED" }),
    }));
  });

  it("keeps the event published even when the saved input asks to unpublish it", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: true, publicInfoUrl: null }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await updateEventSettings("event-1", { ...baseInput, isPublished: false }, "usr_1");

    expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isPublished: true }),
    }));
    expect(result?.isPublished).toBe(true);
  });

  it("never blocks an ordinary save on the publish checklist, since it can no longer publish", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: false, publicInfoUrl: null }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(
      updateEventSettings("event-1", { ...baseInput, isPublished: true, supportContact: null }, "usr_1"),
    ).resolves.toBeTruthy();
    expect(eventUpdate).toHaveBeenCalled();
  });
});

describe("publishEvent (#467, #471)", () => {
  it("publishes a draft with every other item complete and no information URL", async () => {
    const { prisma, eventUpdate, auditLogCreate } = mockPrisma(
      { isPublished: false, publicInfoUrl: null },
      1,
      true,
    );
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await publishEvent("event-1", "usr_1");

    expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { isPublished: true },
    }));
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_PUBLISHED", summary: "Published event: Synthetic Retreat." }),
    }));
    expect(result?.isPublished).toBe(true);
  });

  it("still blocks publish and names what is missing when a required item is incomplete", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: false, publicInfoUrl: null }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(
      publishEvent("event-1", "usr_1"),
    ).rejects.toMatchObject({
      code: "EVENT_NOT_READY",
      message: expect.stringContaining("published registration form"),
    });
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it("never mentions the optional information page in a publish-blocked message", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: false, publicInfoUrl: null }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    const rejection = await publishEvent("event-1", "usr_1").catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(EventOperationError);
    expect((rejection as InstanceType<typeof EventOperationError>).message).not.toContain("information page");
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it("is a no-op, without a duplicate audit entry, when the event is already published", async () => {
    const { prisma, eventUpdate, auditLogCreate } = mockPrisma({ isPublished: true, publicInfoUrl: null }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);

    await publishEvent("event-1", "usr_1");

    expect(eventUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });
});

describe("unpublishEvent (#471)", () => {
  it("unpublishes a published event and records who did it", async () => {
    const { prisma, eventUpdate, auditLogCreate } = mockPrisma({ isPublished: true, publicInfoUrl: null }, 1, false);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await unpublishEvent("event-1", "usr_1");

    expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { isPublished: false },
    }));
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_UNPUBLISHED", summary: "Unpublished event: Synthetic Retreat." }),
    }));
    expect(result?.isPublished).toBe(false);
  });

  it("is a no-op, without a duplicate audit entry, when the event is already unpublished", async () => {
    const { prisma, eventUpdate, auditLogCreate } = mockPrisma({ isPublished: false, publicInfoUrl: null }, 0, false);
    dependencies.getPrisma.mockReturnValue(prisma);

    await unpublishEvent("event-1", "usr_1");

    expect(eventUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("reports EVENT_NOT_FOUND for a missing event", async () => {
    const { prisma, tx } = mockPrisma({ isPublished: true, publicInfoUrl: null }, 1);
    tx.event.findUnique.mockResolvedValue(null);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(unpublishEvent("event-1", "usr_1")).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});
