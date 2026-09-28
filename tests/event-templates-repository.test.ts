import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  applyEventTemplate,
  archiveEventTemplate,
  EventTemplateOperationError,
  publishEventTemplateVersion,
} from "@/modules/event-templates/repository";
import { EventTemplateReferenceError, eventTemplatePayloadSchema } from "@/modules/event-templates/domain";

const basicPayload = eventTemplatePayloadSchema.parse({
  audience: "CLUB",
  formTemplateKeys: ["simple_rsvp"],
  attendeeTypes: [{ code: "ADULT", label: "Adult" }],
  moduleEnablement: { waitlistEnabled: true, autoPromoteWaitlist: true },
});

function versionRow(overrides: Partial<{
  id: string;
  versionNumber: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  payload: unknown;
  publishedAt: Date | null;
}> = {}) {
  return {
    id: overrides.id ?? "version-1",
    versionNumber: overrides.versionNumber ?? 1,
    status: overrides.status ?? "PUBLISHED",
    payload: overrides.payload ?? basicPayload,
    publishedAt: overrides.publishedAt ?? new Date("2027-01-01T00:00:00.000Z"),
    createdAt: new Date("2027-01-01T00:00:00.000Z"),
    updatedAt: new Date("2027-01-01T00:00:00.000Z"),
    createdBy: { displayName: "Template Author" },
  };
}

function templateRow(overrides: Partial<{ status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; versions: ReturnType<typeof versionRow>[] }> = {}) {
  return {
    id: "template-1",
    name: "Weekend Retreat",
    description: "A synthetic retreat template.",
    audience: "CLUB",
    status: overrides.status ?? "PUBLISHED",
    createdByUserId: "usr_admin",
    createdAt: new Date("2027-01-01T00:00:00.000Z"),
    updatedAt: new Date("2027-01-01T00:00:00.000Z"),
    createdBy: { displayName: "Template Author" },
    versions: overrides.versions ?? [versionRow()],
  };
}

const eventRow = {
  id: "event-1",
  name: "Weekend Retreat 2027",
  slug: "weekend-retreat-2027",
  startsAt: new Date("2027-05-01T12:00:00.000Z"),
  endsAt: new Date("2027-05-03T12:00:00.000Z"),
  timezone: "America/Chicago",
  location: null,
  capacity: null,
  publicInfoUrl: null,
  supportContact: null,
  hotelName: null,
  hotelBookingUrl: null,
  hotelPhone: null,
  hotelGroupName: null,
  hotelRate: null,
  hotelInstructions: null,
  isPublished: false,
  registrationOpensOn: null,
  registrationClosesOn: null,
  waitlistEnabled: true,
  collectsShirtSizes: false,
  checksAdultBackgrounds: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT",
  billingMode: "ATTENDEE_PAY",
  audience: "CLUB",
  seminarPreferenceClosesOn: null,
  seminarPreferenceSelfServiceLocked: false,
  autoPromoteWaitlist: true,
  createdAt: new Date("2027-01-01T00:00:00.000Z"),
  updatedAt: new Date("2027-01-01T00:00:00.000Z"),
};

/**
 * Builds a mocked prisma client wired the way `applyEventTemplate` and the
 * `getEventSettings` re-read after it use theirs, mirroring the pattern in
 * `tests/event-publish-readiness-repository.test.ts`. `template` seeds what
 * `eventTemplateApplication.findUnique`/`eventTemplate.findUnique` return
 * before a transaction opens; the `tx` object is what every write inside
 * `applyEventTemplate`'s `$transaction` callback sees.
 */
function mockPrisma(options: {
  template: ReturnType<typeof templateRow> | null;
  existingApplication?: { eventId: string } | null;
  existingFormSlugs?: string[];
} = { template: templateRow() }) {
  const eventCreate = vi.fn().mockResolvedValue(eventRow);
  const auditLogCreate = vi.fn().mockResolvedValue({});
  const applicationCreate = vi.fn().mockResolvedValue({ id: "application-1" });
  const attendeeTypeCreateMany = vi.fn().mockResolvedValue({ count: 1 });
  const registrationFormCreate = vi.fn().mockResolvedValue({ id: "form-1" });
  const slugTaken = new Set(options.existingFormSlugs ?? []);

  const tx = {
    platformSettings: { upsert: vi.fn().mockResolvedValue({ defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT" }) },
    event: { create: eventCreate },
    eventMembership: { create: vi.fn().mockResolvedValue({}) },
    eventAttendeeType: { createMany: attendeeTypeCreateMany },
    eventAttendeeClassification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    registrationForm: {
      findUnique: vi.fn(({ where }: { where: { eventId_slug: { slug: string } } }) => (
        Promise.resolve(slugTaken.has(where.eventId_slug.slug) ? { id: "existing-form" } : null)
      )),
      create: registrationFormCreate,
    },
    eventMessageTemplate: { create: vi.fn().mockResolvedValue({}) },
    eventTemplateApplication: { create: applicationCreate },
    auditLog: { create: auditLogCreate },
  };

  const prisma = {
    eventTemplateApplication: {
      findUnique: vi.fn().mockResolvedValue(options.existingApplication ?? null),
    },
    eventTemplate: {
      findUnique: vi.fn().mockResolvedValue(options.template),
    },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    event: { findUnique: vi.fn().mockResolvedValue(eventRow) },
    registrationForm: { findMany: vi.fn().mockResolvedValue([]) },
    eventPaymentInstructionVersion: { findFirst: vi.fn().mockResolvedValue(null) },
  };

  return { prisma, tx, eventCreate, auditLogCreate, applicationCreate, attendeeTypeCreateMany, registrationFormCreate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyEventTemplate (#152)", () => {
  it("creates a draft event, its attendee types and forms, and records provenance", async () => {
    const { prisma, eventCreate, applicationCreate, attendeeTypeCreateMany, registrationFormCreate, auditLogCreate } = mockPrisma();
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await applyEventTemplate("template-1", "usr_actor", {
      name: "Weekend Retreat 2027",
      slug: "weekend-retreat-2027",
      startsOn: "2027-05-01",
      endsOn: "2027-05-03",
      requestKey: "idempotency-key-0001",
    });

    expect(result.alreadyApplied).toBe(false);
    expect(result.event?.id).toBe("event-1");
    expect(eventCreate).toHaveBeenCalledTimes(1);
    const eventData = eventCreate.mock.calls[0]![0].data;
    expect(eventData).toMatchObject({ audience: "CLUB", waitlistEnabled: true, autoPromoteWaitlist: true, isPublished: false });
    expect(attendeeTypeCreateMany).toHaveBeenCalledWith({ data: [{ eventId: "event-1", code: "ADULT", label: "Adult", description: "", sortOrder: 0, isActive: true, minimumAge: null, maximumAge: null }] });
    expect(registrationFormCreate).toHaveBeenCalledTimes(1);
    expect(applicationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        templateId: "template-1",
        templateVersionId: "version-1",
        eventId: "event-1",
        actorUserId: "usr_actor",
        requestKey: "idempotency-key-0001",
      }),
    }));
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_TEMPLATE_APPLIED" }),
    }));
  });

  it("is idempotent: a retry with the same request key returns the already-created event without creating a second one", async () => {
    const { prisma, eventCreate } = mockPrisma({ template: templateRow(), existingApplication: { eventId: "event-1" } });
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await applyEventTemplate("template-1", "usr_actor", {
      name: "Weekend Retreat 2027",
      slug: "weekend-retreat-2027",
      startsOn: "2027-05-01",
      endsOn: "2027-05-03",
      requestKey: "idempotency-key-0001",
    });

    expect(result.alreadyApplied).toBe(true);
    expect(result.event?.id).toBe("event-1");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("refuses to apply an archived template before creating anything", async () => {
    const { prisma, eventCreate } = mockPrisma({ template: templateRow({ status: "ARCHIVED" }) });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", {
      name: "Weekend Retreat 2027", slug: "weekend-retreat-2027", startsOn: "2027-05-01", endsOn: "2027-05-03", requestKey: "idempotency-key-0002",
    })).rejects.toThrowError(expect.objectContaining({ code: "TEMPLATE_ARCHIVED" }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("refuses to apply a template with no published version", async () => {
    const { prisma, eventCreate } = mockPrisma({ template: templateRow({ versions: [versionRow({ status: "DRAFT" })] }) });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", {
      name: "Weekend Retreat 2027", slug: "weekend-retreat-2027", startsOn: "2027-05-01", endsOn: "2027-05-03", requestKey: "idempotency-key-0003",
    })).rejects.toThrowError(expect.objectContaining({ code: "NO_PUBLISHED_VERSION" }));
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("fails a disabled or unknown module reference before any event is created", async () => {
    const staleVersion = versionRow({
      payload: eventTemplatePayloadSchema.parse({ formTemplateKeys: ["a_removed_template_key"] }),
    });
    const { prisma, eventCreate } = mockPrisma({ template: templateRow({ versions: [staleVersion] }) });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", {
      name: "Weekend Retreat 2027", slug: "weekend-retreat-2027", startsOn: "2027-05-01", endsOn: "2027-05-03", requestKey: "idempotency-key-0004",
    })).rejects.toThrow(EventTemplateReferenceError);
    // The check runs before the transaction opens: nothing was ever written.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
  });
});

describe("publishEventTemplateVersion (#152)", () => {
  it("archives the previous published version without touching its stored payload", async () => {
    const previouslyPublished = versionRow({ id: "version-1", versionNumber: 1, status: "PUBLISHED" });
    const draft = versionRow({ id: "version-2", versionNumber: 2, status: "DRAFT" });
    const versionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const versionUpdate = vi.fn().mockResolvedValue({});
    const templateUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      eventTemplate: {
        findUnique: vi.fn().mockResolvedValue({ ...templateRow(), versions: [draft, previouslyPublished] }),
        update: templateUpdate,
      },
      eventTemplateVersion: { updateMany: versionUpdateMany, update: versionUpdate },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      eventTemplate: { findUnique: vi.fn().mockResolvedValue({ ...templateRow(), versions: [draft] }) },
    };
    dependencies.getPrisma.mockReturnValue(prisma);

    await publishEventTemplateVersion("template-1", "usr_actor");

    expect(versionUpdateMany).toHaveBeenCalledWith({ where: { templateId: "template-1", status: "PUBLISHED" }, data: { status: "ARCHIVED" } });
    // Archiving the superseded version only ever changes its status, never its
    // immutable payload — existing events applied from it must stay unaffected.
    expect(versionUpdateMany.mock.calls[0]![0].data).not.toHaveProperty("payload");
    expect(versionUpdate).toHaveBeenCalledWith({ where: { id: "version-2" }, data: { status: "PUBLISHED", publishedAt: expect.any(Date) } });
    expect(templateUpdate).toHaveBeenCalledWith({ where: { id: "template-1" }, data: { status: "PUBLISHED" } });
  });

  it("refuses to publish a draft whose payload references an unavailable form template", async () => {
    const draft = versionRow({
      status: "DRAFT",
      payload: eventTemplatePayloadSchema.parse({ formTemplateKeys: ["a_removed_template_key"] }),
    });
    const tx = {
      eventTemplate: { findUnique: vi.fn().mockResolvedValue({ ...templateRow(), versions: [draft] }) },
      eventTemplateVersion: { updateMany: vi.fn(), update: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)) };
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(publishEventTemplateVersion("template-1", "usr_actor")).rejects.toThrow(EventTemplateReferenceError);
    expect(tx.eventTemplateVersion.update).not.toHaveBeenCalled();
  });

  it("has nothing to publish when the template has no draft version", async () => {
    const tx = {
      eventTemplate: { findUnique: vi.fn().mockResolvedValue({ ...templateRow(), versions: [versionRow({ status: "PUBLISHED" })] }) },
      eventTemplateVersion: { updateMany: vi.fn(), update: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)) };
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(publishEventTemplateVersion("template-1", "usr_actor"))
      .rejects.toThrowError(expect.objectContaining({ code: "NO_DRAFT" }));
  });
});

describe("archiveEventTemplate (#152)", () => {
  it("archives the template and records an audit entry, without touching its versions", async () => {
    const templateUpdate = vi.fn().mockResolvedValue({});
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tx = {
      eventTemplate: { findUnique: vi.fn().mockResolvedValue(templateRow()), update: templateUpdate },
      auditLog: { create: auditLogCreate },
    };
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      eventTemplate: { findUnique: vi.fn().mockResolvedValue(templateRow({ status: "ARCHIVED" })) },
    };
    dependencies.getPrisma.mockReturnValue(prisma);

    await archiveEventTemplate("template-1", "usr_actor");

    expect(templateUpdate).toHaveBeenCalledWith({ where: { id: "template-1" }, data: { status: "ARCHIVED" } });
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_TEMPLATE_ARCHIVED" }),
    }));
  });

  it("reports not found for a template that does not exist", async () => {
    const tx = { eventTemplate: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() }, auditLog: { create: vi.fn() } };
    const prisma = { $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)) };
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(archiveEventTemplate("missing", "usr_actor"))
      .rejects.toThrowError(expect.objectContaining({ code: "TEMPLATE_NOT_FOUND" }));
  });
});

describe("EventTemplateOperationError", () => {
  it("carries its code for API error mapping", () => {
    const error = new EventTemplateOperationError("EVENT_SLUG_TAKEN", "taken");
    expect(error.code).toBe("EVENT_SLUG_TAKEN");
    expect(error.name).toBe("EventTemplateOperationError");
  });
});
