import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Add starter templates" publishes (#617): new starters are created PUBLISHED, an unchanged draft from an
 * earlier run is published, an edited or archived one is left alone. Synthetic data; the database is a fake.
 */
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { addStarterEventTemplates } from "@/modules/event-templates/starter-repository";
import { starterEventTemplates, starterPayload } from "@/modules/event-templates/starters";

type Existing = { id: string; status: string; versions: Array<{ id: string; status: string; payload: unknown; versionNumber: number; updatedAt: Date }> };

function fakePrisma(existingByKey: Record<string, Existing>) {
  const writes = { created: [] as Array<Record<string, unknown>>, versionUpdates: [] as Array<Record<string, unknown>>, templateUpdates: [] as Array<Record<string, unknown>>, audits: [] as Array<Record<string, unknown>> };
  const tx = {
    $executeRawUnsafe: async () => 0,
    $executeRaw: async () => 0,
    eventTemplate: {
      findFirst: async (args: { where: { versions: { some: { payload: { equals: string } } } } }) => existingByKey[args.where.versions.some.payload.equals] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { writes.created.push(data); return { id: `new_${writes.created.length}`, name: data.name }; },
      update: async (args: Record<string, unknown>) => { writes.templateUpdates.push(args); return {}; },
    },
    eventTemplateVersion: { updateMany: async (args: Record<string, unknown>) => { writes.versionUpdates.push(args); return { count: 1 }; } },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { writes.audits.push(data); return {}; } },
  };
  mocks.getPrisma.mockReturnValue({ $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx) });
  return writes;
}

const starter = starterEventTemplates[0]!;
const draftOf = (payload: unknown): Existing => ({
  id: "tpl_existing", status: "DRAFT",
  versions: [{ id: "ver_1", status: "DRAFT", payload, versionNumber: 1, updatedAt: new Date("2026-09-01T00:00:00Z") }],
});
const others = Object.fromEntries(starterEventTemplates.slice(1).map((entry) => [entry.starterKey, { id: `tpl_${entry.starterKey}`, status: "PUBLISHED", versions: [] } as Existing]));

beforeEach(() => vi.clearAllMocks());

describe("Add starter templates publishes (#617)", () => {
  it("creates each missing starter as a PUBLISHED template with a published first version", async () => {
    const writes = fakePrisma({});
    const result = await addStarterEventTemplates("usr_admin");
    expect(result.added).toHaveLength(starterEventTemplates.length);
    expect(result.published).toEqual([]);
    for (const data of writes.created) {
      expect(data.status).toBe("PUBLISHED");
      const version = (data.versions as { create: { status: string; publishedAt: unknown; versionNumber: number } }).create;
      expect(version).toMatchObject({ status: "PUBLISHED", versionNumber: 1 });
      expect(version.publishedAt).toBeInstanceOf(Date);
    }
  });

  it("publishes a never-published starter draft that still equals the starter definition", async () => {
    // Key order differs from the stored JSON on purpose: Postgres does not keep it.
    const reordered = Object.fromEntries(Object.entries(starterPayload(starter)).reverse());
    const writes = fakePrisma({ [starter.starterKey]: draftOf(reordered), ...others });
    const result = await addStarterEventTemplates("usr_admin");
    expect(result.published.map((entry) => entry.starterKey)).toEqual([starter.starterKey]);
    expect(writes.versionUpdates[0]).toMatchObject({ where: { id: "ver_1", status: "DRAFT" }, data: { status: "PUBLISHED" } });
    expect(writes.templateUpdates[0]).toMatchObject({ where: { id: "tpl_existing" }, data: { status: "PUBLISHED" } });
    expect(writes.audits.some((entry) => entry.action === "EVENT_TEMPLATE_PUBLISHED" && entry.entityId === "tpl_existing")).toBe(true);
  });

  it("leaves an edited draft alone, still reported as existing", async () => {
    const edited = { ...starterPayload(starter), audience: starter.audience === "CLUB" ? "GENERAL" : "CLUB" };
    const writes = fakePrisma({ [starter.starterKey]: draftOf(edited), ...others });
    const result = await addStarterEventTemplates("usr_admin");
    expect(result.published).toEqual([]);
    expect(result.skipped.find((entry) => entry.starterKey === starter.starterKey)?.reason).toBe("ALREADY_EXISTS");
    expect(writes.versionUpdates).toEqual([]);
    expect(writes.templateUpdates).toEqual([]);
  });

  it("leaves an archived or ever-published template alone", async () => {
    const archived = { ...draftOf(starterPayload(starter)), status: "ARCHIVED" };
    const everPublished: Existing = { id: "tpl_old", status: "DRAFT", versions: [
      { id: "ver_2", status: "DRAFT", payload: starterPayload(starter), versionNumber: 2, updatedAt: new Date() },
      { id: "ver_1", status: "ARCHIVED", payload: starterPayload(starter), versionNumber: 1, updatedAt: new Date() },
    ] };
    for (const existing of [archived, everPublished]) {
      const writes = fakePrisma({ [starter.starterKey]: existing, ...others });
      const result = await addStarterEventTemplates("usr_admin");
      expect(result.published).toEqual([]);
      expect(writes.versionUpdates).toEqual([]);
    }
  });
});

describe("Copy result (#617)", () => {
  it("puts the primary Open the new event button ahead of the summary", () => {
    const source = readFileSync("components/copy-from-past-event.tsx", "utf8");
    const button = source.indexOf(">Open the new event</Link>");
    expect(button).toBeGreaterThan(0);
    expect(source.slice(button - 200, button)).toContain('className="primary-button clone-confirm"');
    expect(button).toBeLessThan(source.indexOf('<ul className="clone-plain-list">'));
  });
});
