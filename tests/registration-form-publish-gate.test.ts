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

import { formTemplates } from "@/modules/forms/definition";
import {
  FormOperationError,
  publishRegistrationForm,
} from "@/modules/forms/repository";

const definition = formTemplates[0].definition;

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-2",
    formId: "form-1",
    versionNumber: 2,
    status: "DRAFT",
    definition,
    publishedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    createdBy: { displayName: "Caleb Durant" },
    testSubmissions: [],
    _count: { testSubmissions: 0 },
    ...overrides,
  };
}

function transactionClient(previouslyPublishedCount: number, validTests: number) {
  return {
    registrationForm: {
      findFirst: vi.fn().mockResolvedValue({
        id: "form-1",
        eventId: "event-1",
        name: "Retreat registration",
        versions: [version()],
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    registrationFormVersion: {
      count: vi.fn().mockResolvedValue(previouslyPublishedCount),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
    },
    formTestSubmission: {
      count: vi.fn().mockResolvedValue(validTests),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

function prismaFor(tx: ReturnType<typeof transactionClient>) {
  return {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    registrationForm: {
      findFirst: vi.fn().mockResolvedValue({
        id: "form-1",
        eventId: "event-1",
        name: "Retreat registration",
        slug: "retreat-registration",
        status: "PUBLISHED",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        createdBy: { displayName: "Caleb Durant" },
        versions: [version({ status: "PUBLISHED", publishedAt: new Date("2026-08-02T00:00:00.000Z") })],
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.listActiveAttendeeTypes.mockResolvedValue([]);
});

describe("registration form publish gate", () => {
  it("requires a valid test submission for a form's first published version", async () => {
    const tx = transactionClient(0, 0);
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(
      publishRegistrationForm("event-1", "form-1", "user-1"),
    ).rejects.toMatchObject({ code: "TEST_REQUIRED" });
    expect(tx.registrationFormVersion.update).not.toHaveBeenCalled();
  });

  it("publishes the first version once a valid test exists", async () => {
    const tx = transactionClient(0, 1);
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await publishRegistrationForm("event-1", "form-1", "user-1");

    expect(tx.registrationFormVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "version-2" } }),
    );
  });

  it("publishes a later version without a test once the form has been published before", async () => {
    const tx = transactionClient(1, 0);
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await publishRegistrationForm("event-1", "form-1", "user-1");

    expect(tx.formTestSubmission.count).not.toHaveBeenCalled();
    expect(tx.registrationFormVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "version-2" } }),
    );
  });

  it("counts prior publications by publishedAt so an archived version still counts", async () => {
    const tx = transactionClient(1, 0);
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await publishRegistrationForm("event-1", "form-1", "user-1");

    expect(tx.registrationFormVersion.count).toHaveBeenCalledWith({
      where: { formId: "form-1", publishedAt: { not: null } },
    });
  });

  it("still refuses a form with no draft version", async () => {
    const tx = transactionClient(1, 0);
    tx.registrationForm.findFirst.mockResolvedValue({
      id: "form-1",
      eventId: "event-1",
      name: "Retreat registration",
      versions: [version({ status: "PUBLISHED", publishedAt: new Date() })],
    });
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(
      publishRegistrationForm("event-1", "form-1", "user-1"),
    ).rejects.toBeInstanceOf(FormOperationError);
  });
});
