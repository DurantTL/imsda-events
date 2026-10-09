import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  createEvent,
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
  supportContact: "registration@example.test",
  hotelName: undefined,
  hotelBookingUrl: undefined,
  hotelPhone: undefined,
  hotelGroupName: undefined,
  hotelRate: undefined,
  hotelInstructions: undefined,
  approvedPaymentInstructions: undefined,
  registrationOpensOn: "2027-05-01",
  registrationClosesOn: "2027-10-01",
  collectsShirtSizes: false,
  checksAdultBackgrounds: false,
  hostedPaymentLinkEnabled: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT" as const,
  billingMode: "ATTENDEE_PAY" as const,
  audience: "GENERAL" as const,
  seminarPreferenceClosesOn: null,
  seminarPreferenceSelfServiceLocked: false,
  waitlistEnabled: true,
  autoPromoteWaitlist: true,
};

type RowOverrides = Partial<{
  isPublished: boolean;
  publicInfoUrl: string | null;
  location: string | null;
  supportContact: string | null;
  audience: "GENERAL" | "CLUB";
  billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE";
}>;

const eventRow = (overrides: RowOverrides = {}) => ({
  name: "Synthetic Retreat",
  slug: "synthetic-retreat",
  startsAt: new Date("2027-10-08T12:00:00.000Z"),
  endsAt: new Date("2027-10-10T12:00:00.000Z"),
  timezone: "America/Chicago",
  location: overrides.location === undefined ? "Camp Heritage" : overrides.location,
  capacity: 350,
  publicInfoUrl: overrides.publicInfoUrl ?? null,
  supportContact: overrides.supportContact === undefined ? "registration@example.test" : overrides.supportContact,
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
  hostedPaymentLinkEnabled: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT",
  billingMode: overrides.billingMode ?? "ATTENDEE_PAY",
  audience: overrides.audience ?? ("GENERAL" as const),
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
 * `changedRows` is what the conditional publish/unpublish `updateMany`
 * reports: 0 simulates another request having flipped it first.
 */
function mockPrisma(
  current: RowOverrides & { isPublished: boolean },
  publishedFormCount: number,
  afterIsPublished?: boolean,
  changedRows = 1,
) {
  const eventUpdate = vi.fn().mockResolvedValue({});
  const eventUpdateMany = vi.fn().mockResolvedValue({ count: changedRows });
  const auditLogCreate = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "event-1" }]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    event: {
      findUnique: vi.fn().mockResolvedValue(eventRow(current)),
      update: eventUpdate,
      updateMany: eventUpdateMany,
    },
    registrationFormVersion: {
      count: vi.fn().mockResolvedValue(publishedFormCount),
    },
    eventPaymentInstructionVersion: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    promoCode: { count: vi.fn().mockResolvedValue(0) },
    eventModule: { createMany: vi.fn().mockResolvedValue({ count: 0 }), deleteMany: vi.fn() },
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
    eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
    eventPaymentInstructionVersion: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return { prisma, tx, eventUpdate, eventUpdateMany, auditLogCreate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("event settings save never changes publish state (#471)", () => {
  it("leaves isPublished out of the update entirely, so a racing publish or unpublish is never reverted", async () => {
    const { prisma, eventUpdate, auditLogCreate } = mockPrisma({ isPublished: false }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    await updateEventSettings("event-1", baseInput, "usr_1");

    expect(eventUpdate).toHaveBeenCalledTimes(1);
    const data = eventUpdate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(data, "isPublished")).toBe(false);
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_SETTINGS_UPDATED" }),
    }));
  });

  it("keeps a published event published after a save", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: true }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await updateEventSettings("event-1", baseInput, "usr_1");

    const data = eventUpdate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(data, "isPublished")).toBe(false);
    expect(result?.isPublished).toBe(true);
  });

  it("never blocks an ordinary save on the publish checklist, since it can no longer publish", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: false }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(
      updateEventSettings("event-1", { ...baseInput, supportContact: null }, "usr_1"),
    ).resolves.toBeTruthy();
    expect(eventUpdate).toHaveBeenCalled();
  });
});

describe("publishEvent (#467, #471)", () => {
  it("publishes a draft with every other item complete and no information URL, with a conditional update", async () => {
    const { prisma, tx, eventUpdate, eventUpdateMany, auditLogCreate } = mockPrisma({ isPublished: false }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await publishEvent("event-1", "usr_1");

    expect(eventUpdateMany).toHaveBeenCalledWith({
      where: { id: "event-1", isPublished: false },
      data: { isPublished: true },
    });
    expect(eventUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_PUBLISHED", summary: "Published event: Synthetic Retreat." }),
    }));
    // The row is locked before the checklist is read, so a concurrent
    // settings save can't clear a field between the check and the flip.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(tx.event.findUnique.mock.invocationCallOrder[0]);
    expect(result?.isPublished).toBe(true);
  });

  it("writes no audit entry when a concurrent request already published it", async () => {
    const { prisma, eventUpdateMany, auditLogCreate } = mockPrisma({ isPublished: false }, 1, true, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await publishEvent("event-1", "usr_1");

    expect(eventUpdateMany).toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
    expect(result?.isPublished).toBe(true);
  });

  it("still blocks publish and names what is missing when there is no published form", async () => {
    const { prisma, eventUpdateMany } = mockPrisma({ isPublished: false }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(publishEvent("event-1", "usr_1")).rejects.toMatchObject({
      code: "EVENT_NOT_READY",
      message: expect.stringContaining("published registration form"),
    });
    expect(eventUpdateMany).not.toHaveBeenCalled();
  });

  it("blocks publishing a CLUB event billed to attendees with the church-billing message (#565)", async () => {
    const { prisma, eventUpdateMany, auditLogCreate } = mockPrisma({ isPublished: false, audience: "CLUB", billingMode: "ATTENDEE_PAY" }, 1);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(publishEvent("event-1", "usr_1")).rejects.toMatchObject({
      code: "EVENT_NOT_READY",
      message: "Club registration uses church billing — choose it before publishing.",
    });
    expect(eventUpdateMany).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("publishes a CLUB event once it is church-billed, and an attendee-paid GENERAL event as before (#565)", async () => {
    for (const row of [{ audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" }, { audience: "GENERAL", billingMode: "ATTENDEE_PAY" }] as const) {
      const { prisma, eventUpdateMany } = mockPrisma({ isPublished: false, ...row }, 1, true);
      dependencies.getPrisma.mockReturnValue(prisma);
      await publishEvent("event-1", "usr_1");
      expect(eventUpdateMany).toHaveBeenCalled();
    }
  });

  it("blocks publish when the saved event has no location", async () => {
    const { prisma, eventUpdateMany, auditLogCreate } = mockPrisma({ isPublished: false, location: null }, 1);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(publishEvent("event-1", "usr_1")).rejects.toMatchObject({
      code: "EVENT_NOT_READY",
      message: expect.stringContaining("event location"),
    });
    expect(eventUpdateMany).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("blocks publish when the saved event has no support contact", async () => {
    const { prisma, eventUpdateMany } = mockPrisma({ isPublished: false, supportContact: "   " }, 1);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(publishEvent("event-1", "usr_1")).rejects.toMatchObject({
      code: "EVENT_NOT_READY",
      message: expect.stringContaining("support contact"),
    });
    expect(eventUpdateMany).not.toHaveBeenCalled();
  });

  it("never mentions the information page in a publish-blocked message, even when it is set to an invalid value", async () => {
    const { prisma, eventUpdateMany } = mockPrisma({ isPublished: false, publicInfoUrl: "not-a-url" }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    const rejection = await publishEvent("event-1", "usr_1").catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(EventOperationError);
    const message = (rejection as InstanceType<typeof EventOperationError>).message;
    expect(message).toContain("published registration form");
    expect(message).not.toContain("information page");
    expect(message).not.toContain("IMSDA.org");
    expect(eventUpdateMany).not.toHaveBeenCalled();
  });

  it("publishes even when the optional information URL is invalid", async () => {
    const { prisma, eventUpdateMany } = mockPrisma({ isPublished: false, publicInfoUrl: "not-a-url" }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);

    await publishEvent("event-1", "usr_1");

    expect(eventUpdateMany).toHaveBeenCalled();
  });

  it("is a no-op, without a duplicate audit entry, when the event is already published", async () => {
    const { prisma, eventUpdateMany, auditLogCreate } = mockPrisma({ isPublished: true }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);

    await publishEvent("event-1", "usr_1");

    expect(eventUpdateMany).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });
});

describe("unpublishEvent (#471)", () => {
  it("unpublishes a published event with a conditional update and records who did it", async () => {
    const { prisma, eventUpdateMany, auditLogCreate } = mockPrisma({ isPublished: true }, 1, false);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await unpublishEvent("event-1", "usr_1");

    expect(eventUpdateMany).toHaveBeenCalledWith({
      where: { id: "event-1", isPublished: true },
      data: { isPublished: false },
    });
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_UNPUBLISHED", summary: "Unpublished event: Synthetic Retreat.", actorUserId: "usr_1" }),
    }));
    expect(result?.isPublished).toBe(false);
  });

  it("writes no audit entry when a concurrent request already unpublished it", async () => {
    const { prisma, auditLogCreate } = mockPrisma({ isPublished: true }, 1, false, 0);
    dependencies.getPrisma.mockReturnValue(prisma);

    await unpublishEvent("event-1", "usr_1");

    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("is a no-op, without a duplicate audit entry, when the event is already unpublished", async () => {
    const { prisma, eventUpdateMany, auditLogCreate } = mockPrisma({ isPublished: false }, 0, false);
    dependencies.getPrisma.mockReturnValue(prisma);

    await unpublishEvent("event-1", "usr_1");

    expect(eventUpdateMany).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("reports EVENT_NOT_FOUND for a missing event", async () => {
    const { prisma, tx } = mockPrisma({ isPublished: true }, 1);
    tx.event.findUnique.mockResolvedValue(null);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(unpublishEvent("event-1", "usr_1")).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});

describe("switching a published event into CLUB + attendee-pay (#565)", () => {
  const message = "Club registration uses church billing — choose it before publishing.";

  it("refuses to move a published CLUB event to attendee-pay", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: true, audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);
    await expect(updateEventSettings("event-1", { ...baseInput, audience: "CLUB", billingMode: "ATTENDEE_PAY" }, "usr_1")).rejects.toMatchObject({ code: "EVENT_NOT_READY", message });
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it("refuses to move a published attendee-pay event to CLUB", async () => {
    const { prisma, eventUpdate } = mockPrisma({ isPublished: true, audience: "GENERAL", billingMode: "ATTENDEE_PAY" }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);
    await expect(updateEventSettings("event-1", { ...baseInput, audience: "CLUB", billingMode: "ATTENDEE_PAY" }, "usr_1")).rejects.toMatchObject({ code: "EVENT_NOT_READY", message });
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it("saves an unpublished event with the mix, and leaves a published legacy mismatch editable", async () => {
    const draft = mockPrisma({ isPublished: false, audience: "GENERAL", billingMode: "ATTENDEE_PAY" }, 0);
    dependencies.getPrisma.mockReturnValue(draft.prisma);
    await updateEventSettings("event-1", { ...baseInput, audience: "CLUB", billingMode: "ATTENDEE_PAY" }, "usr_1");
    expect(draft.eventUpdate).toHaveBeenCalled();

    const legacy = mockPrisma({ isPublished: true, audience: "CLUB", billingMode: "ATTENDEE_PAY" }, 1, true);
    dependencies.getPrisma.mockReturnValue(legacy.prisma);
    await updateEventSettings("event-1", { ...baseInput, audience: "CLUB", billingMode: "ATTENDEE_PAY", capacity: 10 }, "usr_1");
    expect(legacy.eventUpdate).toHaveBeenCalled();
  });
});

describe("event audience (#481)", () => {
  it("writes an audience change and audits it like any other event setting", async () => {
    const { prisma, eventUpdate, auditLogCreate } = mockPrisma({ isPublished: true }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);

    await updateEventSettings("event-1", { ...baseInput, audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" }, "usr_1");

    expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ audience: "CLUB" }),
    }));
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "EVENT_SETTINGS_UPDATED",
        metadata: expect.objectContaining({
          before: expect.objectContaining({ audience: "GENERAL" }),
          after: expect.objectContaining({ audience: "CLUB" }),
        }),
      }),
    }));
  });

  it("keeps the stored CLUB audience when an update omits it, so a stale settings tab can't reset it", async () => {
    const { prisma, eventUpdate, auditLogCreate } = mockPrisma({ isPublished: true, audience: "CLUB" }, 1, true);
    dependencies.getPrisma.mockReturnValue(prisma);
    const { audience: _omitted, ...withoutAudience } = baseInput;
    void _omitted;

    await updateEventSettings("event-1", withoutAudience, "usr_1");

    const data = eventUpdate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).toBeDefined();
    expect(data.audience === undefined || data.audience === "CLUB").toBe(true);
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          before: expect.objectContaining({ audience: "CLUB" }),
          after: expect.objectContaining({ audience: "CLUB" }),
        }),
      }),
    }));
  });
});

describe("sponsored promo codes pin the event to a general, attendee-paid event (#545)", () => {
  async function save(input: Record<string, unknown>, sponsoredCodes: number) {
    const { prisma, tx, eventUpdate } = mockPrisma({ isPublished: true }, 1, true);
    tx.promoCode.count.mockResolvedValue(sponsoredCodes);
    dependencies.getPrisma.mockReturnValue(prisma);
    const outcome = await updateEventSettings("event-1", { ...baseInput, ...input } as never, "usr_1").then(() => null, (error: unknown) => error);
    return { outcome, tx, eventUpdate };
  }

  it("refuses to make the event a club event or bill organizations while a code has a sponsor", async () => {
    for (const change of [{ audience: "CLUB" }, { billingMode: "DEFERRED_ORGANIZATION_INVOICE" }]) {
      const { outcome, tx, eventUpdate } = await save(change, 2);
      expect(outcome).toBeInstanceOf(EventOperationError);
      expect(outcome).toMatchObject({ code: "EVENT_HAS_SPONSORED_PROMO_CODES" });
      expect((outcome as Error).message).toContain("Unlink the church sponsors");
      expect(tx.promoCode.count).toHaveBeenCalledWith({ where: { eventId: "event-1", sponsoringOrganizationId: { not: null } } });
      expect(eventUpdate).not.toHaveBeenCalled();
    }
  });

  it("allows the change once no code has a sponsor, and never checks while the event stays general and attendee-paid", async () => {
    // A published event moves to CLUB together with church billing (#565).
    const unlinked = await save({ audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" }, 0);
    expect(unlinked.outcome).toBeNull();
    expect(unlinked.eventUpdate).toHaveBeenCalledTimes(1);
    const staying = await save({}, 3);
    expect(staying.outcome).toBeNull();
    expect(staying.tx.promoCode.count).not.toHaveBeenCalled();
  });

  it("locks the event row FOR NO KEY UPDATE first, with lock_timeout scoped to the wait", async () => {
    const { tx } = await save({}, 0);
    const [strings] = tx.$queryRaw.mock.calls[0] as unknown as [string[]];
    expect(strings.join("?")).toContain("FOR NO KEY UPDATE");
    expect(tx.$executeRawUnsafe.mock.calls.map(([sql]) => sql)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SET LOCAL lock_timeout = 0",
    ]);
  });

  it("reports a lock timeout as a readable busy error, and the refusal explains used codes", async () => {
    const { prisma, tx } = mockPrisma({ isPublished: true }, 1, true);
    tx.$queryRaw.mockRejectedValue(Object.assign(new Error("lock timeout"), { code: "55P03" }));
    dependencies.getPrisma.mockReturnValue(prisma);
    await expect(updateEventSettings("event-1", baseInput as never, "usr_1")).rejects.toMatchObject({ code: "EVENT_BUSY" });
    const refused = await save({ audience: "CLUB" }, 1);
    expect((refused.outcome as Error).message).toContain("has been used can't be unlinked");
  });
});

describe("createEvent audience (#481)", () => {
  function mockCreate() {
    const { prisma } = mockPrisma({ isPublished: false }, 0);
    const eventCreate = vi.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "event-new", name: data.name, slug: data.slug, audience: data.audience }));
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const moduleCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      platformSettings: { upsert: vi.fn().mockResolvedValue({ defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT" }) },
      event: { create: eventCreate },
      eventMembership: { create: vi.fn().mockResolvedValue({}) },
      eventModule: { createMany: moduleCreateMany },
      eventPaymentInstructionVersion: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: auditLogCreate },
    };
    const createPrisma = {
      ...prisma,
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    dependencies.getPrisma.mockReturnValue(createPrisma);
    return { eventCreate, auditLogCreate, moduleCreateMany };
  }

  it("creates a GENERAL event when no audience is given and records it in EVENT_CREATED", async () => {
    const { eventCreate, auditLogCreate, moduleCreateMany } = mockCreate();
    const { audience: _omitted, ...withoutAudience } = baseInput;
    void _omitted;

    await createEvent(withoutAudience, "usr_1");

    // A new event starts with public content only (#741).
    expect(moduleCreateMany.mock.calls[0][0].data).toEqual([{ eventId: "event-new", moduleKey: "public-content" }]);

    expect(eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ audience: "GENERAL" }),
    }));
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "EVENT_CREATED",
        metadata: expect.objectContaining({ audience: "GENERAL" }),
      }),
    }));
  });

  it("records an initial CLUB audience in EVENT_CREATED", async () => {
    const { eventCreate, auditLogCreate, moduleCreateMany } = mockCreate();

    await createEvent({ ...baseInput, audience: "CLUB" }, "usr_1");

    // A club event starts with the club modules (#741).
    expect(moduleCreateMany.mock.calls[0][0].data.map((row: { moduleKey: string }) => row.moduleKey).sort())
      .toEqual(["club-assignments", "event-patches", "honors", "public-content"]);

    expect(eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ audience: "CLUB" }),
    }));
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "EVENT_CREATED",
        metadata: { slug: "synthetic-retreat", audience: "CLUB" },
      }),
    }));
  });
});

describe("changing the audience writes the club modules (#741)", () => {
  async function save(currentAudience: "GENERAL" | "CLUB", nextAudience: "GENERAL" | "CLUB") {
    const { prisma, tx } = mockPrisma({ isPublished: false, audience: currentAudience }, 0);
    dependencies.getPrisma.mockReturnValue(prisma);
    await updateEventSettings("event-1", { ...baseInput, audience: nextAudience, billingMode: nextAudience === "CLUB" ? "DEFERRED_ORGANIZATION_INVOICE" : "ATTENDEE_PAY" } as never, "usr_1");
    return tx;
  }

  it("adds the club defaults when a general event becomes a club event, in the same transaction", async () => {
    const tx = await save("GENERAL", "CLUB");
    expect(tx.eventModule.createMany).toHaveBeenCalledTimes(1);
    const { data, skipDuplicates } = tx.eventModule.createMany.mock.calls[0]![0] as { data: Array<{ eventId: string; moduleKey: string }>; skipDuplicates: boolean };
    expect(skipDuplicates).toBe(true);
    expect(data.every((row) => row.eventId === "event-1")).toBe(true);
    expect(data.map((row) => row.moduleKey).sort()).toEqual(["club-assignments", "event-patches", "honors", "public-content"]);
  });

  it("writes nothing when the event stays CLUB, stays general, or leaves CLUB, and removes nothing", async () => {
    for (const [from, to] of [["CLUB", "CLUB"], ["GENERAL", "GENERAL"], ["CLUB", "GENERAL"]] as const) {
      const tx = await save(from, to);
      expect(tx.eventModule.createMany).not.toHaveBeenCalled();
      expect(tx.eventModule.deleteMany).not.toHaveBeenCalled();
    }
  });
});
