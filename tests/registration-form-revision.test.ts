import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  listActiveAttendeeTypes: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/attendee-types/repository", () => ({
  listActiveAttendeeTypes: dependencies.listActiveAttendeeTypes,
}));

import {
  formTemplates,
  registrationFormDefinitionSchema,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import { unpublishRegistrationForm, updateRegistrationForm } from "@/modules/forms/repository";

// Synthetic fixtures only.
const rosterTemplate = formTemplates.find((template) => template.definition.attendeeRoster?.enabled);
if (!rosterTemplate) throw new Error("Expected a roster form template");
const teamDefinition = rosterTemplate.definition as RegistrationFormDefinition;
const individualDefinition = registrationFormDefinitionSchema.parse({
  ...structuredClone(teamDefinition),
  attendeeRoster: undefined,
  sections: teamDefinition.sections.map((section) => ({
    ...section,
    fields: section.fields.map((field) => ({ ...field, scope: "REGISTRATION" })),
  })),
});

const updatedAt = new Date("2026-09-01T00:00:00.000Z");

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-1",
    formId: "form-1",
    versionNumber: 1,
    status: "PUBLISHED",
    definition: individualDefinition,
    publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    createdAt: updatedAt,
    updatedAt,
    createdBy: { displayName: "Synthetic Staff" },
    testSubmissions: [],
    _count: { testSubmissions: 0 },
    ...overrides,
  };
}

function formRow(versions: unknown[], status = "PUBLISHED") {
  return {
    id: "form-1", eventId: "event-1", name: "Synthetic bowl", slug: "synthetic-bowl", status,
    createdAt: updatedAt, updatedAt, createdBy: { displayName: "Synthetic Staff" }, versions,
  };
}

function txFor(versions: unknown[]) {
  return {
    registrationForm: { findFirst: vi.fn().mockResolvedValue(formRow(versions)), update: vi.fn().mockResolvedValue({}) },
    registrationFormVersion: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    formTestSubmission: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

function prismaFor(tx: ReturnType<typeof txFor>, afterVersions: unknown[]) {
  return {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    registrationForm: { findFirst: vi.fn().mockResolvedValue(formRow(afterVersions)) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.listActiveAttendeeTypes.mockResolvedValue([]);
});

describe("revising a published registration form (#564)", () => {
  it("saves an individual-to-team switch as a new draft and leaves the published version untouched", async () => {
    const published = version();
    const tx = txFor([published]);
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, [
      version({ id: "version-2", versionNumber: 2, status: "DRAFT", definition: teamDefinition, publishedAt: null }),
      published,
    ]));

    const result = await updateRegistrationForm("event-1", "form-1", "user-1", {
      definition: teamDefinition,
      expectedUpdatedAt: updatedAt.toISOString(),
    });

    expect(tx.registrationFormVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ formId: "form-1", versionNumber: 2, status: "DRAFT" }),
    });
    expect(tx.registrationFormVersion.update).not.toHaveBeenCalled();
    expect(tx.registrationFormVersion.updateMany).not.toHaveBeenCalled();
    expect(result.activeVersion.versionNumber).toBe(2);
    expect(result.activeVersion.definition.attendeeRoster?.enabled).toBe(true);
    expect(result.versions.find((item) => item.versionNumber === 1)?.status).toBe("PUBLISHED");
  });

  it("creates the next draft from a withdrawn (archived) version", async () => {
    const archived = version({ status: "ARCHIVED" });
    const tx = txFor([archived]);
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, [
      version({ id: "version-2", versionNumber: 2, status: "DRAFT", publishedAt: null }),
      archived,
    ]));

    await updateRegistrationForm("event-1", "form-1", "user-1", {
      definition: individualDefinition,
      expectedUpdatedAt: updatedAt.toISOString(),
    });

    expect(tx.registrationFormVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ versionNumber: 2, status: "DRAFT" }),
    });
  });
});

describe("withdrawing a published registration form (#564)", () => {
  it("archives the published version so the public page closes, and reports the withdrawn state", async () => {
    const published = version();
    const tx = txFor([published]);
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, [version({ status: "ARCHIVED" })]));

    const result = await unpublishRegistrationForm("event-1", "form-1", "user-1");

    expect(tx.registrationFormVersion.updateMany).toHaveBeenCalledWith({
      where: { formId: "form-1", status: "PUBLISHED" },
      data: { status: "ARCHIVED" },
    });
    expect(tx.registrationForm.update).toHaveBeenCalledWith({ where: { id: "form-1" }, data: { status: "ARCHIVED" } });
    expect(result.activeVersion.status).toBe("ARCHIVED");
    expect(result.versions.some((item) => item.status === "PUBLISHED")).toBe(false);
  });

  it("refuses to withdraw a form that is not published", async () => {
    const tx = txFor([]);
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, []));

    await expect(unpublishRegistrationForm("event-1", "form-1", "user-1")).rejects.toMatchObject({ code: "NOT_PUBLISHED" });
  });
});
