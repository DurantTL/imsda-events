import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ArchiveTemplateDialog } from "@/components/archive-template-dialog";
import { EventTemplateList } from "@/components/event-template-list";
import { StartFromTemplate } from "@/components/start-from-template";
import { eventTemplatePayloadSchema } from "@/modules/event-templates/domain";
import { validateTemplateEdits } from "@/modules/event-templates/editor-guards";
import {
  orderedFromTemplateErrors,
  validateFromTemplateForm,
} from "@/modules/event-templates/from-template-validation";
import type { EventTemplateRecord } from "@/modules/event-templates/repository";
import { addStarterEventTemplates, ensureStarterEventTemplates } from "@/modules/event-templates/starter-repository";
import { starterEventTemplates } from "@/modules/event-templates/starters";

function record(overrides: Partial<EventTemplateRecord> = {}): EventTemplateRecord {
  return {
    id: "template-1",
    name: "Synthetic Retreat",
    description: "A synthetic template.",
    audience: "GENERAL",
    status: "PUBLISHED",
    canApply: true,
    createdBy: "Synthetic Author",
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
    versions: [],
    ...overrides,
  } as EventTemplateRecord;
}

describe("archive confirmation (#704)", () => {
  const noop = () => undefined;

  it("names the template and says what archiving does, with a destructive confirm button", () => {
    const markup = renderToStaticMarkup(createElement(ArchiveTemplateDialog, {
      busy: false, error: "", name: "Synthetic Retreat", onCancel: noop, onConfirm: noop, open: true,
    }));
    expect(markup).toContain("Archive Synthetic Retreat?");
    expect(markup).toContain("no longer appears in");
    expect(markup).toContain("can unarchive it later");
    expect(markup).toContain(">Archive Synthetic Retreat</button>");
  });

  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(createElement(ArchiveTemplateDialog, {
      busy: false, error: "", name: "x", onCancel: noop, onConfirm: noop, open: false,
    }))).toBe("");
  });

  it("shows a failure inside the open dialog", () => {
    const markup = renderToStaticMarkup(createElement(ArchiveTemplateDialog, {
      busy: false, error: "The template could not be archived.", name: "x", onCancel: noop, onConfirm: noop, open: true,
    }));
    expect(markup).toContain("The template could not be archived.");
  });

  it("offers Archive for live templates and Unarchive for archived ones in the list", () => {
    const markup = renderToStaticMarkup(createElement(EventTemplateList, {
      initialTemplates: [record(), record({ id: "template-2", name: "Old One", status: "ARCHIVED", canApply: false })],
    }));
    expect(markup).toContain(">Archive</button>");
    expect(markup).toContain(">Unarchive</button>");
    expect((markup.match(/>Archive<\/button>/g) ?? []).length).toBe(1);
    expect(markup).not.toContain("Archive Synthetic Retreat?");
  });

  it("never lists an archived template as startable", () => {
    const markup = renderToStaticMarkup(createElement(StartFromTemplate, {
      templates: [record({ status: "ARCHIVED", canApply: false })],
    }));
    expect(markup).toContain("No published templates yet");
    expect(markup).toContain("disabled");
  });
});

describe("template editor validation (#704)", () => {
  const good = JSON.stringify(eventTemplatePayloadSchema.parse({ audience: "GENERAL" }));

  it("accepts a valid name, description and payload", () => {
    const result = validateTemplateEdits({ name: "Weekend Retreat", description: "", payloadText: good });
    expect(result.ok).toBe(true);
  });

  it("reports malformed JSON against the payload field", () => {
    const result = validateTemplateEdits({ name: "Weekend Retreat", description: "", payloadText: "{ nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ field: "payload", path: "payload" });
      expect(result.errors[0]!.message).toMatch(/not valid JSON/);
    }
  });

  it("reports invalid payload fields with their paths", () => {
    const result = validateTemplateEdits({
      name: "Weekend Retreat",
      description: "",
      payloadText: JSON.stringify({ audience: "EVERYONE", moduleEnablement: { removedToggle: true } }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((error) => error.path);
      expect(paths).toContain("audience");
      expect(result.errors.every((error) => error.field === "payload")).toBe(true);
    }
  });

  it("reports a too-short name against the name field", () => {
    const result = validateTemplateEdits({ name: " ", description: "", payloadText: good });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatchObject({ field: "name", message: "Name the template." });
  });
});

describe("create-from-template validation (#704)", () => {
  const valid = { templateId: "template-1", name: "Weekend Retreat 2027", slug: "weekend-retreat-2027", startsOn: "2027-05-01", endsOn: "2027-05-03" };

  it("passes a complete form", () => {
    expect(validateFromTemplateForm(valid)).toEqual({});
  });

  it("names every missing field, in page order", () => {
    const errors = validateFromTemplateForm({ templateId: "", name: "", slug: "", startsOn: "", endsOn: "" });
    expect(orderedFromTemplateErrors(errors).map((entry) => entry.label)).toEqual([
      "Template", "Event name", "Web address", "Starts on", "Ends on",
    ]);
  });

  it("flags an end date before the start date and a malformed web address", () => {
    const errors = validateFromTemplateForm({ ...valid, slug: "Not A Slug!", endsOn: "2027-04-30" });
    expect(errors.endsOn).toBe("The event cannot end before it starts.");
    expect(errors.slug).toBeTruthy();
    expect(errors.name).toBeUndefined();
  });

  it("keeps the submit button enabled so an invalid submit is explained, not silent", () => {
    const markup = renderToStaticMarkup(createElement(StartFromTemplate, { templates: [record()] }));
    expect(markup).toMatch(/<button[^>]*primary-button[^>]*>Create draft event/);
    expect(markup).not.toMatch(/<button[^>]*primary-button[^>]*disabled/);
  });
});

describe("starter template seeding (#704)", () => {
  function mockPrisma(options: { templateCount: number; existing: unknown }) {
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      eventTemplate: {
        findFirst: vi.fn().mockResolvedValue(options.existing),
        create: vi.fn().mockResolvedValue({ id: "created", name: "Created" }),
        updateMany: vi.fn(),
      },
      eventTemplateVersion: { updateMany: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      eventTemplate: { count: vi.fn().mockResolvedValue(options.templateCount) },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    dependencies.getPrisma.mockReturnValue(prisma);
    return { tx, prisma };
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("seeds every starter on a database with no templates", async () => {
    const { tx } = mockPrisma({ templateCount: 0, existing: null });
    expect(await ensureStarterEventTemplates("usr_admin")).toBe(true);
    expect(tx.eventTemplate.create).toHaveBeenCalledTimes(starterEventTemplates.length);
  });

  it("does nothing once any template exists", async () => {
    const { prisma } = mockPrisma({ templateCount: 1, existing: null });
    expect(await ensureStarterEventTemplates("usr_admin")).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("is idempotent and never overwrites an edited or archived starter", async () => {
    const edited = {
      id: "template-edited", name: "Renamed by an admin", description: "edited", status: "ARCHIVED",
      versions: [{ id: "v1", status: "PUBLISHED", payload: { starterKey: "man_camp", edited: true }, versionNumber: 1, updatedAt: new Date() }],
    };
    const { tx } = mockPrisma({ templateCount: 1, existing: edited });
    const result = await addStarterEventTemplates("usr_admin");
    expect(result.added).toEqual([]);
    expect(result.skipped).toHaveLength(starterEventTemplates.length);
    expect(tx.eventTemplate.create).not.toHaveBeenCalled();
    expect(tx.eventTemplate.updateMany).not.toHaveBeenCalled();
    expect(tx.eventTemplateVersion.updateMany).not.toHaveBeenCalled();
  });
});

describe("duplicate review (#704)", () => {
  it("no longer renders the placeholder Merge button", () => {
    const source = readFileSync("components/duplicate-match-review-workspace.tsx", "utf8");
    expect(source).not.toMatch(/Merge \(coming soon\)/);
    expect(source).not.toMatch(/<Merge\b/);
  });
});
