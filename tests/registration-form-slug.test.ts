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
  updateRegistrationFormSlug,
} from "@/modules/forms/repository";
import { slugify } from "@/modules/forms/slug";

const definition = formTemplates[0].definition;

function versionRow(overrides: Record<string, unknown> = {}) {
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

// The shape `updateRegistrationFormSlug`'s own precheck reads (a narrow
// `select`), before it has ever been published.
function neverPublishedPrecheck(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    name: "Honors Weekend Registration",
    slug: "womens-retreat-registration",
    versions: [{ publishedAt: null }],
    ...overrides,
  };
}

// The full shape `getRegistrationForm` reads back at the end, via
// `serializeForm` — what every FormOperationError-free call returns.
function fullFormRow(slug: string) {
  return {
    id: "form-1",
    eventId: "event-1",
    name: "Honors Weekend Registration",
    slug,
    status: "DRAFT",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    createdBy: { displayName: "Caleb Durant" },
    versions: [versionRow()],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.listActiveAttendeeTypes.mockResolvedValue([]);
});

describe("form slug sync before first publish (#476)", () => {
  it("detects when a renamed form's title no longer matches its slug, the same way the builder does", () => {
    expect(slugify("Honors Weekend Registration")).toBe("honors-weekend-registration");
    expect(slugify("Honors Weekend Registration")).not.toBe("womens-retreat-registration");
  });

  it("updates the slug when staff choose the new address, on a never-published form", async () => {
    const findFirst = vi.fn()
      .mockResolvedValueOnce(neverPublishedPrecheck())
      .mockResolvedValueOnce(fullFormRow("honors-weekend-registration"));
    const findUnique = vi.fn().mockResolvedValue(null); // no other form owns the new address
    const update = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = { registrationForm: { findUnique, update }, auditLog: { create: auditCreate } };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
      registrationForm: { findFirst },
    });

    const result = await updateRegistrationFormSlug("event-1", "form-1", "user-1", "honors-weekend-registration");

    expect(findUnique).toHaveBeenCalledWith({
      where: { eventId_slug: { eventId: "event-1", slug: "honors-weekend-registration" } },
      select: { id: true },
    });
    expect(update).toHaveBeenCalledWith({ where: { id: "form-1" }, data: { slug: "honors-weekend-registration" } });
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "REGISTRATION_FORM_SLUG_UPDATED" }),
    }));
    expect(result.slug).toBe("honors-weekend-registration");
  });

  it("keeps the current slug and makes no write when staff choose to keep the old address", async () => {
    const findFirst = vi.fn()
      .mockResolvedValueOnce(neverPublishedPrecheck())
      .mockResolvedValueOnce(fullFormRow("womens-retreat-registration"));
    const transactionSpy = vi.fn();
    dependencies.getPrisma.mockReturnValue({ $transaction: transactionSpy, registrationForm: { findFirst } });

    const result = await updateRegistrationFormSlug("event-1", "form-1", "user-1", "womens-retreat-registration");

    expect(transactionSpy).not.toHaveBeenCalled();
    expect(result.slug).toBe("womens-retreat-registration");
  });

  it("refuses a web address already used by another form in the event, with the same message style as event addresses", async () => {
    const findFirst = vi.fn().mockResolvedValue(neverPublishedPrecheck());
    const findUnique = vi.fn().mockResolvedValue({ id: "form-2" }); // another form already has it
    const update = vi.fn();
    const tx = { registrationForm: { findUnique, update }, auditLog: { create: vi.fn() } };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
      registrationForm: { findFirst },
    });

    await expect(
      updateRegistrationFormSlug("event-1", "form-1", "user-1", "honors-weekend-registration"),
    ).rejects.toMatchObject({ code: "FORM_SLUG_TAKEN" });
    expect(update).not.toHaveBeenCalled();
  });

  it("locks the slug once any version of the form has ever been published", async () => {
    const findFirst = vi.fn().mockResolvedValue(
      neverPublishedPrecheck({ versions: [{ publishedAt: new Date("2026-08-02T00:00:00.000Z") }] }),
    );
    const transactionSpy = vi.fn();
    dependencies.getPrisma.mockReturnValue({ $transaction: transactionSpy, registrationForm: { findFirst } });

    await expect(
      updateRegistrationFormSlug("event-1", "form-1", "user-1", "a-brand-new-address"),
    ).rejects.toMatchObject({ code: "SLUG_LOCKED" });
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("raises FORM_NOT_FOUND for a form outside the event", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    dependencies.getPrisma.mockReturnValue({ $transaction: vi.fn(), registrationForm: { findFirst } });

    await expect(
      updateRegistrationFormSlug("event-1", "missing-form", "user-1", "anything"),
    ).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
  });
});

describe("a published form's slug never changes on its own", () => {
  function transactionClient(previouslyPublishedCount: number, validTests: number) {
    return {
      registrationForm: {
        findFirst: vi.fn().mockResolvedValue({
          id: "form-1",
          eventId: "event-1",
          name: "Retreat registration",
          versions: [versionRow()],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      registrationFormVersion: {
        count: vi.fn().mockResolvedValue(previouslyPublishedCount),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
      formTestSubmission: { count: vi.fn().mockResolvedValue(validTests) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
  }

  it("never includes a slug field in what publish writes to the form or version", async () => {
    const tx = transactionClient(0, 1);
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
      registrationForm: { findFirst: vi.fn().mockResolvedValue(fullFormRow("honors-weekend-registration")) },
    });

    await publishRegistrationForm("event-1", "form-1", "user-1");

    const [formUpdateArgs] = tx.registrationForm.update.mock.calls[0] as [{ data: Record<string, unknown> }];
    const [versionUpdateArgs] = tx.registrationFormVersion.update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(formUpdateArgs.data).not.toHaveProperty("slug");
    expect(versionUpdateArgs.data).not.toHaveProperty("slug");
  });

  it("still exposes no repository path that writes a slug once a version was ever published", async () => {
    const findFirst = vi.fn().mockResolvedValue(
      neverPublishedPrecheck({ versions: [{ publishedAt: new Date("2026-08-02T00:00:00.000Z") }] }),
    );
    dependencies.getPrisma.mockReturnValue({ $transaction: vi.fn(), registrationForm: { findFirst } });

    await expect(
      updateRegistrationFormSlug("event-1", "form-1", "user-1", "renamed-again"),
    ).rejects.toBeInstanceOf(FormOperationError);
  });
});
