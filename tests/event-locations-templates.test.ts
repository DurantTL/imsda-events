import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { applyEventTemplate } from "@/modules/event-templates/repository";
import { eventTemplatePayloadSchema, templateLocationSchema } from "@/modules/event-templates/domain";

/**
 * Templates create locations on the new event (#413), dates counted as day
 * offsets from the new event's first day so they move with the event's own
 * dates. Synthetic data only.
 */

const loadedAt = new Date("2027-01-01T00:00:00.000Z");
const eventRow = {
  id: "event-1", name: "Honors Weekend 2027", slug: "honors-weekend-2027",
  startsAt: new Date("2027-12-04T12:00:00.000Z"), endsAt: new Date("2027-12-05T12:00:00.000Z"), timezone: "America/Chicago",
  location: null, capacity: null, publicInfoUrl: null, supportContact: null, hotelName: null, hotelBookingUrl: null, hotelPhone: null,
  hotelGroupName: null, hotelRate: null, hotelInstructions: null, isPublished: false, registrationOpensOn: null, registrationClosesOn: null,
  waitlistEnabled: false, collectsShirtSizes: false, checksAdultBackgrounds: false, attendeeEditPolicy: "VERIFY_EVERY_EDIT",
  billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB", seminarPreferenceClosesOn: null, seminarPreferenceSelfServiceLocked: false,
  autoPromoteWaitlist: false, createdAt: loadedAt, updatedAt: loadedAt,
};
const applyInput = { name: "Honors Weekend 2027", slug: "honors-weekend-2027", startsOn: "2027-12-04", endsOn: "2027-12-05", requestKey: "idempotency-key-0001" };

function mockApply(payload: unknown) {
  const locationCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const auditLogCreate = vi.fn().mockResolvedValue({});
  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ status: "PUBLISHED" }]),
    eventTemplate: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "template-1", name: "Honors Weekend" }) },
    eventTemplateVersion: {
      findFirst: vi.fn().mockResolvedValue({ id: "version-1", versionNumber: 1, status: "PUBLISHED", payload }),
    },
    platformSettings: { upsert: vi.fn().mockResolvedValue({ defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT" }) },
    event: { create: vi.fn().mockResolvedValue(eventRow) },
    eventMembership: { create: vi.fn().mockResolvedValue({}) },
    eventAttendeeType: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    eventAttendeeClassification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    eventLocation: { createMany: locationCreateMany },
    registrationForm: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "form-1", name: "RSVP" }) },
    eventMessageTemplate: { create: vi.fn().mockResolvedValue({}) },
    eventTemplateApplication: { create: vi.fn().mockResolvedValue({ id: "application-1" }) },
    auditLog: { create: auditLogCreate },
  };
  dependencies.getPrisma.mockReturnValue({
    eventTemplateApplication: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    event: { findUnique: vi.fn().mockResolvedValue(eventRow) },
    registrationForm: { findMany: vi.fn().mockResolvedValue([]) },
    eventPaymentInstructionVersion: { findFirst: vi.fn().mockResolvedValue(null) },
  });
  return { tx, locationCreateMany, auditLogCreate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("template locations (#413)", () => {
  it("accepts a template with no locations exactly as before, leaving the stored payload unchanged", () => {
    const payload = eventTemplatePayloadSchema.parse({ audience: "CLUB" });
    expect(payload.locations).toBeUndefined();
    expect("locations" in payload).toBe(false);
  });

  it("validates a location: a name, a positive capacity, and a last day not before the first", () => {
    expect(templateLocationSchema.parse({ name: "Des Moines" })).toEqual({
      name: "Des Moines", address: null, capacity: null, firstDayOffset: null, lastDayOffset: null, registrationClosesOffset: null, coordinatorAccountId: null,
    });
    expect(templateLocationSchema.safeParse({ name: "" }).success).toBe(false);
    expect(templateLocationSchema.safeParse({ name: "A", capacity: 0 }).success).toBe(false);
    expect(templateLocationSchema.safeParse({ name: "A", firstDayOffset: 2, lastDayOffset: 1 }).success).toBe(false);
    expect(templateLocationSchema.safeParse({ name: "A", registrationClosesOffset: -30 }).success).toBe(true);
    expect(templateLocationSchema.safeParse({ name: "A", surprise: true }).success).toBe(false);
  });

  it("refuses a repeated location name, ignoring case", () => {
    const result = eventTemplatePayloadSchema.safeParse({ locations: [{ name: "Des Moines" }, { name: " des  MOINES " }] });
    expect(result.success).toBe(false);
  });

  it("creates the locations in order on the new event, with dates counted from its first day", async () => {
    const { tx, locationCreateMany, auditLogCreate } = mockApply(eventTemplatePayloadSchema.parse({
      audience: "CLUB",
      locations: [
        { name: "Camp Heritage 1", address: "1 Synthetic Rd", capacity: 120, firstDayOffset: 0, lastDayOffset: 1, registrationClosesOffset: -14 },
        { name: "Des Moines", capacity: 80 },
        { name: "Kansas City Multicultural", firstDayOffset: 14, lastDayOffset: 15, registrationClosesOffset: 7 },
      ],
    }));
    await applyEventTemplate("template-1", "usr_actor", applyInput);
    expect(tx.event.create).toHaveBeenCalledTimes(1);
    expect(locationCreateMany).toHaveBeenCalledTimes(1);
    const rows = locationCreateMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.name)).toEqual(["Camp Heritage 1", "Des Moines", "Kansas City Multicultural"]);
    expect(rows.map((row) => row.sortOrder)).toEqual([0, 1, 2]);
    expect(rows.every((row) => row.eventId === "event-1")).toBe(true);
    expect(rows[0]).toMatchObject({
      normalizedName: "camp heritage 1", address: "1 Synthetic Rd", capacity: 120,
      firstDay: "2027-12-04", lastDay: "2027-12-05", registrationClosesOn: "2027-11-20",
    });
    expect(rows[1]).toMatchObject({ firstDay: null, lastDay: null, registrationClosesOn: null, capacity: 80 });
    expect(rows[2]).toMatchObject({ firstDay: "2027-12-18", lastDay: "2027-12-19", registrationClosesOn: "2027-12-11" });
    expect(auditLogCreate.mock.calls[0]![0].data.metadata).toMatchObject({ locationCount: 3 });
  });

  it("carries a location's coordinator only while that account is still an active Area Coordinator (#599)", async () => {
    const { tx, locationCreateMany } = mockApply(eventTemplatePayloadSchema.parse({
      audience: "CLUB",
      locations: [
        { name: "Camp Heritage 1", coordinatorAccountId: "account-active" },
        { name: "Des Moines", coordinatorAccountId: "account-revoked" },
        { name: "Kansas City Multicultural" },
      ],
    }));
    const now = new Date();
    (tx as unknown as Record<string, unknown>).attendeeAccount = {
      findMany: vi.fn().mockResolvedValue([
        { id: "account-active", areaCoordinatorGrant: { revokedAt: null, expiresAt: null } },
        { id: "account-revoked", areaCoordinatorGrant: { revokedAt: new Date(now.getTime() - 1000), expiresAt: null } },
      ]),
    };
    await applyEventTemplate("template-1", "usr_actor", applyInput);
    const rows = locationCreateMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.coordinatorAccountId)).toEqual(["account-active", null, null]);
  });

  it("asks nobody about coordinators when no location names one", async () => {
    const { tx } = mockApply(eventTemplatePayloadSchema.parse({ audience: "CLUB", locations: [{ name: "Des Moines" }] }));
    const findMany = vi.fn();
    (tx as unknown as Record<string, unknown>).attendeeAccount = { findMany };
    await applyEventTemplate("template-1", "usr_actor", applyInput);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("accepts a coordinator on a template location, with none by default", () => {
    expect(templateLocationSchema.parse({ name: "A", coordinatorAccountId: "account-1" }).coordinatorAccountId).toBe("account-1");
    expect(templateLocationSchema.parse({ name: "A" }).coordinatorAccountId).toBeNull();
    expect(templateLocationSchema.safeParse({ name: "A", coordinatorAccountId: "" }).success).toBe(false);
  });

  it("creates no location rows for a template without locations", async () => {
    const { locationCreateMany } = mockApply(eventTemplatePayloadSchema.parse({ audience: "CLUB" }));
    await applyEventTemplate("template-1", "usr_actor", applyInput);
    expect(locationCreateMany).not.toHaveBeenCalled();
  });
});
