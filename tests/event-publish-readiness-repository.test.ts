import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { EventOperationError, updateEventSettings } from "@/modules/events/repository";

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

/**
 * Mirrors what `updateEventSettings` actually reads/writes through
 * `$transaction`, mocked rather than hitting a real database — the same
 * pattern `tests/event-overview-church-billed.test.ts` uses for another
 * repository function in this module.
 */
function mockPrisma(current: {
  isPublished: boolean;
  publicInfoUrl?: string | null;
  /**
   * `getEventSettings` re-reads the event through `prisma.event.findUnique`
   * (not the transaction client) once the write commits, so this mock must
   * reflect the state the test expects after that write — the given
   * `isPublished` only ever describes what was there *before* the call.
   */
  afterPublish?: boolean;
}, publishedFormCount: number) {
  const eventUpdate = vi.fn().mockResolvedValue({});
  const auditLogCreate = vi.fn().mockResolvedValue({});
  const tx: {
    event: { findUnique: ReturnType<typeof vi.fn>; update: typeof eventUpdate };
    registrationFormVersion: { count: ReturnType<typeof vi.fn> };
    eventPaymentInstructionVersion: { findFirst: ReturnType<typeof vi.fn> };
    auditLog: { create: typeof auditLogCreate };
  } = {
    event: {
      findUnique: vi.fn().mockResolvedValue({
        name: "Synthetic Retreat",
        slug: "synthetic-retreat",
        startsAt: new Date("2027-10-08T12:00:00.000Z"),
        endsAt: new Date("2027-10-10T12:00:00.000Z"),
        timezone: "America/Chicago",
        location: "Camp Heritage",
        capacity: 350,
        publicInfoUrl: current.publicInfoUrl ?? null,
        supportContact: "registration@imsda.org",
        hotelName: null,
        hotelBookingUrl: null,
        hotelPhone: null,
        hotelGroupName: null,
        hotelRate: null,
        hotelInstructions: null,
        isPublished: current.isPublished,
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
      }),
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
        name: "Synthetic Retreat",
        slug: "synthetic-retreat",
        startsAt: new Date("2027-10-08T12:00:00.000Z"),
        endsAt: new Date("2027-10-10T12:00:00.000Z"),
        timezone: "America/Chicago",
        location: "Camp Heritage",
        capacity: 350,
        publicInfoUrl: current.publicInfoUrl ?? null,
        supportContact: "registration@imsda.org",
        hotelName: null,
        hotelBookingUrl: null,
        hotelPhone: null,
        hotelGroupName: null,
        hotelRate: null,
        hotelInstructions: null,
        isPublished: current.afterPublish ?? current.isPublished,
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
        createdAt: new Date("2027-01-01T00:00:00.000Z"),
        updatedAt: new Date("2027-01-01T00:00:00.000Z"),
      }),
    },
    registrationForm: { findMany: vi.fn().mockResolvedValue([]) },
    eventPaymentInstructionVersion: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return { prisma, tx, eventUpdate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("event publish readiness gate (#467)", () => {
  it("publishes a draft with every other item complete and no information URL", async () => {
    const { prisma, eventUpdate } = mockPrisma(
      { isPublished: false, publicInfoUrl: null, afterPublish: true },
      1,
    );
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await updateEventSettings("event-1", { ...baseInput, publicInfoUrl: null }, "usr_1");

    expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isPublished: true, publicInfoUrl: null }),
    }));
    expect(result?.isPublished).toBe(true);
  });

  it("still blocks publish and names what is missing when an actually required item is incomplete", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: false, publicInfoUrl: null }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(
      updateEventSettings("event-1", { ...baseInput, publicInfoUrl: null, supportContact: null }, "usr_1"),
    ).rejects.toMatchObject({
      code: "EVENT_NOT_READY",
      message: expect.stringContaining("published registration form"),
    });
    await expect(
      updateEventSettings("event-1", { ...baseInput, publicInfoUrl: null, supportContact: null }, "usr_1"),
    ).rejects.toMatchObject({
      message: expect.stringContaining("support contact"),
    });
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it("never mentions the information page in a publish-blocked message, even when it is set to an invalid value", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: false, publicInfoUrl: null }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(
      updateEventSettings("event-1", { ...baseInput, publicInfoUrl: "not-a-url" }, "usr_1"),
    ).rejects.toMatchObject({
      code: "EVENT_NOT_READY",
    });
    const rejection = await updateEventSettings(
      "event-1",
      { ...baseInput, publicInfoUrl: "not-a-url" },
      "usr_1",
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(EventOperationError);
    expect((rejection as InstanceType<typeof EventOperationError>).message).not.toContain("information page");
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it("publishes with a valid information URL configured, same as before", async () => {
    const { prisma, eventUpdate } = mockPrisma(
      { isPublished: false, publicInfoUrl: null, afterPublish: true },
      1,
    );
    dependencies.getPrisma.mockReturnValue(prisma);

    await updateEventSettings(
      "event-1",
      { ...baseInput, publicInfoUrl: "https://imsda.org/event/synthetic-retreat/" },
      "usr_1",
    );

    expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isPublished: true,
        publicInfoUrl: "https://imsda.org/event/synthetic-retreat/",
      }),
    }));
  });
});
