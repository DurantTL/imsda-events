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

import { Prisma } from "@prisma/client";
import { formTemplates, updateFormSlugSchema } from "@/modules/forms/definition";
import {
  FormOperationError,
  publishRegistrationForm,
  suggestRegistrationFormSlug,
  updateRegistrationFormSlug,
} from "@/modules/forms/repository";
import { slugCandidate, slugify, slugMatchesTitle } from "@/modules/forms/slug";

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

// The shape `updateRegistrationFormSlug` reads inside its transaction (a
// narrow `select`), before it has ever been published.
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

/**
 * A Prisma client whose transaction runs against `tx`, where the form lookup
 * (`findFirst`) happens, and whose top-level `findFirst` is the read-back
 * `getRegistrationForm` does after a successful call.
 */
function prismaFor(tx: Record<string, unknown>, readBack: unknown = null) {
  return {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    registrationForm: { findFirst: vi.fn().mockResolvedValue(readBack) },
  };
}

describe("form slug sync before first publish (#476)", () => {
  it("detects when a renamed form's title no longer matches its slug, the same way the builder does", () => {
    expect(slugify("Honors Weekend Registration")).toBe("honors-weekend-registration");
    expect(slugMatchesTitle("womens-retreat-registration", "Honors Weekend Registration")).toBe(false);
    expect(slugMatchesTitle("honors-weekend-registration", "Honors Weekend Registration")).toBe(true);
  });

  it("treats a -2/-3 suffix added at creation as already matching the title", () => {
    expect(slugMatchesTitle("honors-weekend-registration-2", "Honors Weekend Registration")).toBe(true);
    expect(slugMatchesTitle("honors-weekend-registration-3", "Honors Weekend Registration")).toBe(true);
    expect(slugMatchesTitle("honors-weekend-registration-x", "Honors Weekend Registration")).toBe(false);
    expect(slugMatchesTitle("honors-weekend-2", "Honors Weekend Registration")).toBe(false);
  });

  it("never ends a slug in a hyphen after shortening a long title", () => {
    // 59 letters then a space: the 60-character cut lands on the separator.
    const title = `${"a".repeat(59)} tail`;
    const slug = slugify(title);
    expect(slug).toBe("a".repeat(59));
    expect(updateFormSlugSchema.safeParse({ slug }).success).toBe(true);
    const candidate = slugCandidate(slug, 12);
    expect(candidate.length).toBeLessThanOrEqual(60);
    expect(updateFormSlugSchema.safeParse({ slug: candidate }).success).toBe(true);
  });

  it("updates the slug when staff choose the new address, on a never-published form", async () => {
    const findFirst = vi.fn().mockResolvedValue(neverPublishedPrecheck());
    const findUnique = vi.fn().mockResolvedValue(null); // no other form owns the new address
    const update = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = { registrationForm: { findFirst, findUnique, update }, auditLog: { create: auditCreate } };
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, fullFormRow("honors-weekend-registration")));

    const result = await updateRegistrationFormSlug("event-1", "form-1", "user-1", "honors-weekend-registration");

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "form-1", eventId: "event-1" } }));
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
    const update = vi.fn();
    const tx = { registrationForm: { findFirst: vi.fn().mockResolvedValue(neverPublishedPrecheck()), findUnique: vi.fn(), update }, auditLog: { create: vi.fn() } };
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, fullFormRow("womens-retreat-registration")));

    const result = await updateRegistrationFormSlug("event-1", "form-1", "user-1", "womens-retreat-registration");

    expect(update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(result.slug).toBe("womens-retreat-registration");
  });

  it("refuses a web address already used by another form in the event", async () => {
    const update = vi.fn();
    const tx = {
      registrationForm: { findFirst: vi.fn().mockResolvedValue(neverPublishedPrecheck()), findUnique: vi.fn().mockResolvedValue({ id: "form-2" }), update },
      auditLog: { create: vi.fn() },
    };
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(
      updateRegistrationFormSlug("event-1", "form-1", "user-1", "honors-weekend-registration"),
    ).rejects.toMatchObject({ code: "FORM_SLUG_TAKEN" });
    expect(update).not.toHaveBeenCalled();
  });

  it("maps a unique-constraint race on the write to FORM_SLUG_TAKEN", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    const tx = {
      registrationForm: { findFirst: vi.fn().mockResolvedValue(neverPublishedPrecheck()), findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockRejectedValue(conflict) },
      auditLog: { create: vi.fn() },
    };
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(
      updateRegistrationFormSlug("event-1", "form-1", "user-1", "honors-weekend-registration"),
    ).rejects.toMatchObject({ code: "FORM_SLUG_TAKEN" });
  });

  it("locks the slug once any version of the form has ever been published, checked inside the transaction", async () => {
    const update = vi.fn();
    const tx = {
      registrationForm: {
        findFirst: vi.fn().mockResolvedValue(neverPublishedPrecheck({ versions: [{ publishedAt: new Date("2026-08-02T00:00:00.000Z") }] })),
        findUnique: vi.fn(),
        update,
      },
      auditLog: { create: vi.fn() },
    };
    const prisma = prismaFor(tx);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(
      updateRegistrationFormSlug("event-1", "form-1", "user-1", "a-brand-new-address"),
    ).rejects.toMatchObject({ code: "SLUG_LOCKED" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.registrationForm.findFirst).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("raises FORM_NOT_FOUND for a form outside the event", async () => {
    const tx = { registrationForm: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn(), update: vi.fn() }, auditLog: { create: vi.fn() } };
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(
      updateRegistrationFormSlug("event-1", "missing-form", "user-1", "anything"),
    ).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
  });
});

describe("the address offered before a first publish (#476)", () => {
  function suggestionPrisma(slug: string, title: string, otherSlugs: string[], publishedAt: Date | null = null) {
    const draftDefinition = { ...definition, title };
    return {
      registrationForm: {
        findFirst: vi.fn().mockResolvedValue({
          id: "form-1",
          slug,
          versions: [{ status: publishedAt ? "PUBLISHED" : "DRAFT", publishedAt, definition: draftDefinition }],
        }),
        findMany: vi.fn().mockResolvedValue(otherSlugs.map((other) => ({ slug: other }))),
      },
    };
  }

  it("does not prompt for a form whose -2 suffix was added at creation", async () => {
    dependencies.getPrisma.mockReturnValue(suggestionPrisma("honors-weekend-registration-2", "Honors Weekend Registration", ["honors-weekend-registration"]));

    await expect(suggestRegistrationFormSlug("event-1", "form-1")).resolves.toMatchObject({ needsSync: false });
  });

  it("offers the next free address, the same way creation picks one, when the plain one is taken", async () => {
    dependencies.getPrisma.mockReturnValue(suggestionPrisma(
      "womens-retreat-registration",
      "Honors Weekend Registration",
      ["honors-weekend-registration", "honors-weekend-registration-2"],
    ));

    await expect(suggestRegistrationFormSlug("event-1", "form-1")).resolves.toMatchObject({
      currentSlug: "womens-retreat-registration",
      offeredSlug: "honors-weekend-registration-3",
      needsSync: true,
    });
  });

  it("offers the plain title address when it is free", async () => {
    dependencies.getPrisma.mockReturnValue(suggestionPrisma("womens-retreat-registration", "Honors Weekend Registration", ["other-form"]));

    await expect(suggestRegistrationFormSlug("event-1", "form-1")).resolves.toMatchObject({
      offeredSlug: "honors-weekend-registration",
      needsSync: true,
    });
  });

  it("never offers a change once the form has been published", async () => {
    dependencies.getPrisma.mockReturnValue(suggestionPrisma("womens-retreat-registration", "Honors Weekend Registration", [], new Date("2026-08-02T00:00:00.000Z")));

    await expect(suggestRegistrationFormSlug("event-1", "form-1")).resolves.toMatchObject({ needsSync: false, locked: true });
  });
});

describe("a published form's slug never changes on its own", () => {
  function transactionClient(previouslyPublishedCount: number, validTests: number) {
    return {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([]),
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
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    const promoteCall = tx.registrationFormVersion.updateMany.mock.calls.at(-1) as [{ data: Record<string, unknown> }];
    const [versionUpdateArgs] = promoteCall;
    expect(formUpdateArgs.data).not.toHaveProperty("slug");
    expect(versionUpdateArgs.data).not.toHaveProperty("slug");
  });

  it("still exposes no repository path that writes a slug once a version was ever published", async () => {
    const update = vi.fn();
    const tx = {
      registrationForm: {
        findFirst: vi.fn().mockResolvedValue(neverPublishedPrecheck({ versions: [{ publishedAt: new Date("2026-08-02T00:00:00.000Z") }] })),
        findUnique: vi.fn(),
        update,
      },
      auditLog: { create: vi.fn() },
    };
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(
      updateRegistrationFormSlug("event-1", "form-1", "user-1", "renamed-again"),
    ).rejects.toBeInstanceOf(FormOperationError);
    expect(update).not.toHaveBeenCalled();
  });
});
