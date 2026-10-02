import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  applyEventTemplate,
  archiveEventTemplate,
  unarchiveEventTemplate,
  EventTemplateOperationError,
  getEventTemplate,
  publishEventTemplateVersion,
  saveEventTemplateDraft,
} from "@/modules/event-templates/repository";
import { EventTemplateReferenceError, eventTemplatePayloadSchema } from "@/modules/event-templates/domain";

const basicPayload = eventTemplatePayloadSchema.parse({
  audience: "CLUB",
  formTemplateKeys: ["simple_rsvp"],
  attendeeTypes: [{ code: "ADULT", label: "Adult" }],
  moduleEnablement: { waitlistEnabled: true, autoPromoteWaitlist: true },
});

const loadedAt = new Date("2027-01-01T00:00:00.000Z");

function versionRow(overrides: Partial<{
  id: string;
  versionNumber: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  payload: unknown;
  publishedAt: Date | null;
  updatedAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "version-1",
    templateId: "template-1",
    versionNumber: overrides.versionNumber ?? 1,
    status: overrides.status ?? "PUBLISHED",
    payload: overrides.payload ?? basicPayload,
    publishedAt: overrides.publishedAt ?? new Date("2027-01-01T00:00:00.000Z"),
    createdAt: loadedAt,
    updatedAt: overrides.updatedAt ?? loadedAt,
    createdBy: { displayName: "Template Author" },
  };
}

function templateRow(overrides: Partial<{ status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; versions: ReturnType<typeof versionRow>[] }> = {}) {
  return {
    id: "template-1",
    name: "Weekend Retreat",
    description: "A synthetic retreat template.",
    status: overrides.status ?? "PUBLISHED",
    createdByUserId: "usr_admin",
    createdAt: loadedAt,
    updatedAt: loadedAt,
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
  createdAt: loadedAt,
  updatedAt: loadedAt,
};

const applyInput = {
  name: "Weekend Retreat 2027",
  slug: "weekend-retreat-2027",
  startsOn: "2027-05-01",
  endsOn: "2027-05-03",
  requestKey: "idempotency-key-0001",
};

function storedApplication(overrides: Partial<{ templateId: string; requestInput: unknown }> = {}) {
  return {
    eventId: "event-1",
    templateId: overrides.templateId ?? "template-1",
    requestInput: overrides.requestInput ?? { name: applyInput.name, slug: applyInput.slug, startsOn: applyInput.startsOn, endsOn: applyInput.endsOn },
  };
}

/**
 * A mocked prisma client wired the way `applyEventTemplate` and the
 * `getEventSettings` re-read after it use theirs. `tx.$queryRaw` stands in for
 * the template row lock and returns the template's status.
 */
function mockApply(options: {
  templateStatus?: "DRAFT" | "PUBLISHED" | "ARCHIVED" | null;
  publishedVersion?: ReturnType<typeof versionRow> | null;
  existingApplication?: ReturnType<typeof storedApplication> | null;
} = {}) {
  const templateStatus = options.templateStatus === undefined ? "PUBLISHED" : options.templateStatus;
  const eventCreate = vi.fn().mockResolvedValue(eventRow);
  const auditLogCreate = vi.fn().mockResolvedValue({});
  const applicationCreate = vi.fn().mockResolvedValue({ id: "application-1" });
  const attendeeTypeCreateMany = vi.fn().mockResolvedValue({ count: 1 });
  const registrationFormCreate = vi.fn().mockResolvedValue({ id: "form-1", name: "RSVP" });
  const messageTemplateCreate = vi.fn().mockResolvedValue({});

  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue(templateStatus ? [{ status: templateStatus }] : []),
    eventTemplate: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "template-1", name: "Weekend Retreat" }) },
    eventTemplateVersion: {
      findFirst: vi.fn().mockResolvedValue(options.publishedVersion === undefined ? versionRow() : options.publishedVersion),
    },
    platformSettings: { upsert: vi.fn().mockResolvedValue({ defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT" }) },
    event: { create: eventCreate },
    eventMembership: { create: vi.fn().mockResolvedValue({}) },
    eventModule: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    eventAttendeeType: { createMany: attendeeTypeCreateMany },
    eventAttendeeClassification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    registrationForm: { findUnique: vi.fn().mockResolvedValue(null), create: registrationFormCreate },
    eventMessageTemplate: { create: messageTemplateCreate },
    eventTemplateApplication: { create: applicationCreate },
    auditLog: { create: auditLogCreate },
  };

  const prisma = {
    eventTemplateApplication: {
      findUnique: vi.fn().mockResolvedValue(options.existingApplication ?? null),
    },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    event: { findUnique: vi.fn().mockResolvedValue(eventRow) },
    registrationForm: { findMany: vi.fn().mockResolvedValue([]) },
    eventPaymentInstructionVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
  };

  return { prisma, tx, eventCreate, auditLogCreate, applicationCreate, attendeeTypeCreateMany, registrationFormCreate, messageTemplateCreate };
}

function uniqueViolation(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test", meta: { target } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyEventTemplate (#152)", () => {
  it("creates a draft event, its attendee types and forms, and records provenance", async () => {
    const { prisma, tx, eventCreate, applicationCreate, attendeeTypeCreateMany, registrationFormCreate, auditLogCreate } = mockApply();
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await applyEventTemplate("template-1", "usr_actor", applyInput);

    expect(result.alreadyApplied).toBe(false);
    expect(result.event?.id).toBe("event-1");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL lock_timeout = '5s'");
    expect(eventCreate).toHaveBeenCalledTimes(1);
    const eventData = eventCreate.mock.calls[0]![0].data;
    expect(eventData).toMatchObject({ audience: "CLUB", waitlistEnabled: true, autoPromoteWaitlist: true, isPublished: false });
    // A CLUB payload saved before billing existed carries none and applies church billing (#565).
    expect(basicPayload.billingMode).toBeUndefined();
    expect(eventData.billingMode).toBe("DEFERRED_ORGANIZATION_INVOICE");
    expect(attendeeTypeCreateMany).toHaveBeenCalledWith({ data: [{ eventId: "event-1", code: "ADULT", label: "Adult", description: "", sortOrder: 0, isActive: true, minimumAge: null, maximumAge: null }] });
    expect(registrationFormCreate).toHaveBeenCalledTimes(1);
    expect(applicationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        templateId: "template-1",
        templateVersionId: "version-1",
        eventId: "event-1",
        actorUserId: "usr_actor",
        requestKey: "idempotency-key-0001",
        requestInput: { name: applyInput.name, slug: applyInput.slug, startsOn: applyInput.startsOn, endsOn: applyInput.endsOn },
      }),
    }));
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_TEMPLATE_APPLIED" }),
    }));
  });

  it("creates forms through the forms module: directory options stripped and REGISTRATION_FORM_CREATED audited (N3)", async () => {
    const { prisma, registrationFormCreate, auditLogCreate } = mockApply();
    dependencies.getPrisma.mockReturnValue(prisma);

    await applyEventTemplate("template-1", "usr_actor", applyInput);

    expect(registrationFormCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventId: "event-1" }) }));
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "REGISTRATION_FORM_CREATED", entityId: "form-1", eventId: "event-1" }),
    }));
  });

  it("is idempotent per actor: a retry with the same key and details returns the already-created event", async () => {
    const { prisma, eventCreate } = mockApply({ existingApplication: storedApplication() });
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await applyEventTemplate("template-1", "usr_actor", applyInput);

    expect(result.alreadyApplied).toBe(true);
    expect(result.event?.id).toBe("event-1");
    expect(prisma.eventTemplateApplication.findUnique).toHaveBeenCalledWith({
      where: { actorUserId_requestKey: { actorUserId: "usr_actor", requestKey: "idempotency-key-0001" } },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["a different slug", { requestInput: { ...storedApplication().requestInput, slug: "another-slug" } }],
    ["a different name", { requestInput: { ...storedApplication().requestInput, name: "Another Event" } }],
    ["different dates", { requestInput: { ...storedApplication().requestInput, endsOn: "2027-05-04" } }],
    ["a different template", { templateId: "template-2" }],
  ])("refuses a reused key with %s instead of returning the old event (N1)", async (_label, override) => {
    const { prisma, eventCreate } = mockApply({ existingApplication: storedApplication(override) });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", applyInput))
      .rejects.toThrowError(expect.objectContaining({ code: "REQUEST_KEY_REUSED" }));
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("returns the racing request's event when the slug unique index fires first (B4)", async () => {
    const { prisma, eventCreate } = mockApply();
    eventCreate.mockRejectedValueOnce(uniqueViolation(["slug"]));
    prisma.eventTemplateApplication.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(storedApplication());
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await applyEventTemplate("template-1", "usr_actor", applyInput);

    expect(result).toMatchObject({ alreadyApplied: true, event: { id: "event-1" } });
  });

  it("reports a slug taken by an unrelated event as EVENT_SLUG_TAKEN", async () => {
    const { prisma, eventCreate } = mockApply();
    eventCreate.mockRejectedValueOnce(uniqueViolation(["slug"]));
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", applyInput))
      .rejects.toThrowError(expect.objectContaining({ code: "EVENT_SLUG_TAKEN" }));
  });

  it("refuses to apply an archived template before creating anything", async () => {
    const { prisma, eventCreate } = mockApply({ templateStatus: "ARCHIVED" });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", { ...applyInput, requestKey: "idempotency-key-0002" }))
      .rejects.toThrowError(expect.objectContaining({ code: "TEMPLATE_ARCHIVED" }));
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("reports an unknown template as not found", async () => {
    const { prisma } = mockApply({ templateStatus: null });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("missing", "usr_actor", applyInput))
      .rejects.toThrowError(expect.objectContaining({ code: "TEMPLATE_NOT_FOUND" }));
  });

  it("refuses to apply a template with no published version", async () => {
    const { prisma, eventCreate } = mockApply({ publishedVersion: null });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", { ...applyInput, requestKey: "idempotency-key-0003" }))
      .rejects.toThrowError(expect.objectContaining({ code: "NO_PUBLISHED_VERSION" }));
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("fails a disabled or unknown module reference before any event is created", async () => {
    const { prisma, eventCreate } = mockApply({
      publishedVersion: versionRow({ payload: eventTemplatePayloadSchema.parse({ formTemplateKeys: ["a_removed_template_key"] }) }),
    });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", { ...applyInput, requestKey: "idempotency-key-0004" }))
      .rejects.toThrow(EventTemplateReferenceError);
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("refuses a stored message default that no longer passes the communications rules, creating nothing (B2)", async () => {
    const { prisma, eventCreate, messageTemplateCreate } = mockApply({
      publishedVersion: versionRow({ payload: {
        ...basicPayload,
        messageTemplateDefaults: [{ key: "REGISTRATION_CONFIRMATION", isEnabled: true, subjectTemplate: "Hi {{not_a_token}}\nBcc: x@example.test", bodyTemplate: "Body" }],
      } }),
    });
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", applyInput)).rejects.toThrow(EventTemplateReferenceError);
    expect(eventCreate).not.toHaveBeenCalled();
    expect(messageTemplateCreate).not.toHaveBeenCalled();
  });

  it("rejects an impossible date before touching the database (B3)", async () => {
    const { prisma } = mockApply();
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyEventTemplate("template-1", "usr_actor", { ...applyInput, startsOn: "2027-02-30" })).rejects.toThrow();
    expect(prisma.eventTemplateApplication.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

function mockMutation(options: { status?: "DRAFT" | "PUBLISHED" | "ARCHIVED"; versions: ReturnType<typeof versionRow>[]; casCount?: number }) {
  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ status: options.status ?? "PUBLISHED" }]),
    eventTemplate: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ name: "Weekend Retreat" }),
      update: vi.fn().mockResolvedValue({ name: "Weekend Retreat" }),
    },
    eventTemplateVersion: {
      findMany: vi.fn().mockResolvedValue(options.versions),
      findFirst: vi.fn().mockResolvedValue(options.versions.find((version) => version.status === "DRAFT") ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: options.casCount ?? 1 }),
      create: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    eventTemplate: { findUnique: vi.fn().mockResolvedValue(templateRow({ status: options.status, versions: options.versions })) },
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return { tx, prisma };
}

describe("saveEventTemplateDraft (#152 B1)", () => {
  const input = { name: "Weekend Retreat", description: "", payload: basicPayload, expectedUpdatedAt: loadedAt.toISOString() };

  it("locks the template, then writes the draft by compare-and-set on id, DRAFT status, and updatedAt", async () => {
    const draft = versionRow({ id: "version-2", versionNumber: 2, status: "DRAFT" });
    const { tx } = mockMutation({ versions: [draft, versionRow()] });

    await saveEventTemplateDraft("template-1", "usr_actor", input);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.eventTemplateVersion.updateMany).toHaveBeenCalledWith({
      where: { id: "version-2", status: "DRAFT", updatedAt: loadedAt },
      data: expect.objectContaining({ payload: basicPayload, createdByUserId: "usr_actor" }),
    });
    // Saving never changes the template's lifecycle status.
    expect(tx.eventTemplate.update).toHaveBeenCalledWith({ where: { id: "template-1" }, data: { name: "Weekend Retreat", description: "" } });
  });

  it("reports EDIT_CONFLICT when the compare-and-set matches no draft row", async () => {
    const draft = versionRow({ id: "version-2", versionNumber: 2, status: "DRAFT" });
    const { tx } = mockMutation({ versions: [draft, versionRow()], casCount: 0 });

    await expect(saveEventTemplateDraft("template-1", "usr_actor", input))
      .rejects.toThrowError(expect.objectContaining({ code: "EDIT_CONFLICT" }));
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("reports EDIT_CONFLICT for a stale expectedUpdatedAt and never writes", async () => {
    const draft = versionRow({ id: "version-2", versionNumber: 2, status: "DRAFT", updatedAt: new Date("2027-01-02T00:00:00.000Z") });
    const { tx } = mockMutation({ versions: [draft, versionRow()] });

    await expect(saveEventTemplateDraft("template-1", "usr_actor", input))
      .rejects.toThrowError(expect.objectContaining({ code: "EDIT_CONFLICT" }));
    expect(tx.eventTemplateVersion.updateMany).not.toHaveBeenCalled();
  });

  it("opens a new draft over the published version and never updates the published row", async () => {
    const { tx } = mockMutation({ versions: [versionRow({ versionNumber: 3 })] });

    await saveEventTemplateDraft("template-1", "usr_actor", input);

    expect(tx.eventTemplateVersion.updateMany).not.toHaveBeenCalled();
    expect(tx.eventTemplateVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ versionNumber: 4, status: "DRAFT" }) });
  });

  it("refuses to edit an archived template, so archiving sticks (N2)", async () => {
    const { tx } = mockMutation({ status: "ARCHIVED", versions: [versionRow()] });

    await expect(saveEventTemplateDraft("template-1", "usr_actor", input))
      .rejects.toThrowError(expect.objectContaining({ code: "TEMPLATE_ARCHIVED" }));
    expect(tx.eventTemplateVersion.create).not.toHaveBeenCalled();
    expect(tx.eventTemplate.update).not.toHaveBeenCalled();
  });
});

describe("publishEventTemplateVersion (#152)", () => {
  it("archives the previous published version, then flips the validated draft by compare-and-set", async () => {
    const draft = versionRow({ id: "version-2", versionNumber: 2, status: "DRAFT" });
    const { tx } = mockMutation({ versions: [draft, versionRow()] });

    await publishEventTemplateVersion("template-1", "usr_actor");

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.eventTemplateVersion.updateMany).toHaveBeenNthCalledWith(1, { where: { templateId: "template-1", status: "PUBLISHED" }, data: { status: "ARCHIVED" } });
    expect(tx.eventTemplateVersion.updateMany.mock.calls[0]![0].data).not.toHaveProperty("payload");
    expect(tx.eventTemplateVersion.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "version-2", status: "DRAFT", updatedAt: loadedAt },
      data: { status: "PUBLISHED", publishedAt: expect.any(Date) },
    });
    expect(tx.eventTemplate.update).toHaveBeenCalledWith({ where: { id: "template-1" }, data: { status: "PUBLISHED" } });
  });

  it("reports EDIT_CONFLICT when the draft changed after it was validated", async () => {
    const draft = versionRow({ id: "version-2", versionNumber: 2, status: "DRAFT" });
    const { tx } = mockMutation({ versions: [draft] });
    tx.eventTemplateVersion.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });

    await expect(publishEventTemplateVersion("template-1", "usr_actor"))
      .rejects.toThrowError(expect.objectContaining({ code: "EDIT_CONFLICT" }));
    expect(tx.eventTemplate.update).not.toHaveBeenCalled();
  });

  it("refuses to publish a draft whose payload references an unavailable form template", async () => {
    const draft = versionRow({ status: "DRAFT", payload: eventTemplatePayloadSchema.parse({ formTemplateKeys: ["a_removed_template_key"] }) });
    const { tx } = mockMutation({ versions: [draft] });

    await expect(publishEventTemplateVersion("template-1", "usr_actor")).rejects.toThrow(EventTemplateReferenceError);
    expect(tx.eventTemplateVersion.updateMany).not.toHaveBeenCalled();
  });

  it("has nothing to publish when the template has no draft version", async () => {
    mockMutation({ versions: [versionRow({ status: "PUBLISHED" })] });

    await expect(publishEventTemplateVersion("template-1", "usr_actor"))
      .rejects.toThrowError(expect.objectContaining({ code: "NO_DRAFT" }));
  });

  it("refuses to publish an archived template's draft (N2)", async () => {
    const { tx } = mockMutation({ status: "ARCHIVED", versions: [versionRow({ status: "DRAFT" })] });

    await expect(publishEventTemplateVersion("template-1", "usr_actor"))
      .rejects.toThrowError(expect.objectContaining({ code: "TEMPLATE_ARCHIVED" }));
    expect(tx.eventTemplateVersion.updateMany).not.toHaveBeenCalled();
  });
});

describe("archiveEventTemplate (#152)", () => {
  it("locks and archives the template and records an audit entry, without touching its versions", async () => {
    const { tx } = mockMutation({ versions: [versionRow()] });

    await archiveEventTemplate("template-1", "usr_actor");

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.eventTemplate.update).toHaveBeenCalledWith({ where: { id: "template-1" }, data: { status: "ARCHIVED" } });
    expect(tx.eventTemplateVersion.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_TEMPLATE_ARCHIVED" }),
    }));
  });

  it("reports not found for a template that does not exist", async () => {
    const { tx } = mockMutation({ versions: [] });
    tx.$queryRaw.mockResolvedValue([]);

    await expect(archiveEventTemplate("missing", "usr_actor"))
      .rejects.toThrowError(expect.objectContaining({ code: "TEMPLATE_NOT_FOUND" }));
  });
});

describe("unarchiveEventTemplate (#704)", () => {
  it("restores a template with a published version to PUBLISHED and audits it", async () => {
    const { tx } = mockMutation({ status: "ARCHIVED", versions: [versionRow()] });
    tx.eventTemplateVersion.findFirst.mockResolvedValue({ id: "version-1" });

    await unarchiveEventTemplate("template-1", "usr_actor");

    expect(tx.eventTemplate.update).toHaveBeenCalledWith({ where: { id: "template-1" }, data: { status: "PUBLISHED" } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_TEMPLATE_UNARCHIVED", actorUserId: "usr_actor", metadata: { restoredStatus: "PUBLISHED" } }),
    }));
  });

  it("restores a never-published template to DRAFT", async () => {
    const { tx } = mockMutation({ status: "ARCHIVED", versions: [versionRow({ status: "DRAFT" })] });
    tx.eventTemplateVersion.findFirst.mockResolvedValue(null);

    await unarchiveEventTemplate("template-1", "usr_actor");

    expect(tx.eventTemplate.update).toHaveBeenCalledWith({ where: { id: "template-1" }, data: { status: "DRAFT" } });
  });

  it("refuses a template that is not archived and writes nothing", async () => {
    const { tx } = mockMutation({ status: "PUBLISHED", versions: [versionRow()] });

    await expect(unarchiveEventTemplate("template-1", "usr_actor"))
      .rejects.toThrowError(expect.objectContaining({ code: "TEMPLATE_NOT_ARCHIVED" }));
    expect(tx.eventTemplate.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("serializing templates for display (N5, N6)", () => {
  it("shows a stale payload with its issues instead of failing the page", async () => {
    const stale = versionRow({ id: "version-1", payload: { moduleEnablement: { removedToggle: true } } });
    mockMutation({ versions: [stale] });

    const template = await getEventTemplate("template-1");

    expect(template.versions[0]!.payload).toEqual({ moduleEnablement: { removedToggle: true } });
    expect(template.versions[0]!.payloadIssues.length).toBeGreaterThan(0);
    expect(template.canApply).toBe(false);
  });

  it("takes the audience from the published payload, and stays appliable while a newer draft exists", async () => {
    const draft = versionRow({ id: "version-2", versionNumber: 2, status: "DRAFT", payload: eventTemplatePayloadSchema.parse({ audience: "GENERAL" }) });
    mockMutation({ versions: [draft, versionRow()] });

    const template = await getEventTemplate("template-1");

    expect(template.audience).toBe("CLUB");
    expect(template.canApply).toBe(true);
  });

  it("an archived template can never be applied", async () => {
    mockMutation({ status: "ARCHIVED", versions: [versionRow()] });
    expect((await getEventTemplate("template-1")).canApply).toBe(false);
  });
});

describe("EventTemplateOperationError", () => {
  it("carries its code for API error mapping", () => {
    const error = new EventTemplateOperationError("EVENT_SLUG_TAKEN", "taken");
    expect(error.code).toBe("EVENT_SLUG_TAKEN");
    expect(error.name).toBe("EventTemplateOperationError");
  });
});
