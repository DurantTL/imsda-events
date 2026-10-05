import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  templates: [] as Array<Record<string, unknown> & { id: string; key: string }>,
  versions: [] as Array<Record<string, unknown>>,
  submissions: [] as Array<Record<string, unknown> & { id: string }>,
  audit: [] as Array<Record<string, unknown>>,
  nextId: 1,
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}) {
  return Object.entries(where).every(([field, expected]) => {
    if (expected && typeof expected === "object" && "startsWith" in (expected as object)) return String(row[field]).startsWith((expected as { startsWith: string }).startsWith);
    return row[field] === expected;
  });
}

const client = {
  $queryRaw: vi.fn(async () => []),
  $executeRaw: vi.fn(async () => 0),
  $transaction: async (work: (tx: unknown) => unknown) => {
    // Roll back on failure, like a real transaction.
    const snapshot = structuredClone({ t: state.templates, v: state.versions, s: state.submissions, a: state.audit });
    try {
      return await work(client);
    } catch (error) {
      state.templates.splice(0, state.templates.length, ...snapshot.t);
      state.versions.splice(0, state.versions.length, ...snapshot.v);
      state.submissions.splice(0, state.submissions.length, ...snapshot.s);
      state.audit.splice(0, state.audit.length, ...snapshot.a);
      throw error;
    }
  },
  clubFormTemplate: {
    findUnique: async ({ where }: { where: Record<string, unknown> }) => state.templates.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => state.templates.filter((row) => matches(row, where)),
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => state.templates.find((row) => matches(row, where)) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `tpl-${state.nextId++}`, draft: null, draftUpdatedAt: null, customizedAt: null, ...data } as unknown as (typeof state.templates)[number];
      state.templates.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = state.templates.find((candidate) => matches(candidate, where))!;
      Object.assign(row, data);
      if (data.draft === Prisma.DbNull) row.draft = null;
      return row;
    },
    upsert: async ({ where, create }: { where: Record<string, unknown>; create: Record<string, unknown> }) => {
      const found = state.templates.find((row) => matches(row, where));
      if (found) return found;
      const row = { id: `tpl-${state.nextId++}`, draft: null, draftUpdatedAt: null, customizedAt: null, ...create } as unknown as (typeof state.templates)[number];
      state.templates.push(row);
      return row;
    },
  },
  clubFormTemplateVersion: {
    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const item of data) {
        if (!state.versions.some((row) => row.templateId === item.templateId && row.version === item.version)) state.versions.push({ createdAt: new Date("2026-10-05T15:00:00Z"), ...item });
      }
      return { count: data.length };
    },
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => state.versions.filter((row) => matches(row, where)),
    findUnique: async ({ where }: { where: { templateId_version: { templateId: string; version: number } } }) =>
      state.versions.find((row) => row.templateId === where.templateId_version.templateId && row.version === where.templateId_version.version) ?? null,
  },
  organization: {
    findUnique: async () => ({ type: "CLUB", isActive: true }),
    findMany: async () => [],
  },
  clubFormSubmission: {
    create: async ({ data }: { data: Record<string, unknown> & { id: string } }) => { state.submissions.push({ ...data }); return data; },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = state.submissions.filter((row) => matches(row, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => state.submissions.filter((row) => matches(row, where)).length,
    findMany: async ({ where, cursor, skip = 0, take }: { where?: Record<string, unknown>; cursor?: { id: string }; skip?: number; take?: number } = {}) => {
      const rows = state.submissions.filter((row) => matches(row, where)).sort((left, right) => left.id.localeCompare(right.id));
      const start = cursor ? rows.findIndex((row) => row.id === cursor.id) + skip : 0;
      return rows.slice(start, take === undefined ? undefined : start + take);
    },
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const row = state.submissions.find((candidate) => matches(candidate, { id: where?.id }));
      if (!row) return null;
      const template = state.templates.find((candidate) => candidate.id === row.templateId)!;
      return { ...row, organization: { name: "Example Pathfinders" }, template };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(state.submissions.find((row) => row.id === where.id)!, data);
    },
  },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-club-form-tests" }) }));
vi.mock("@/modules/audit/audit-service", () => ({
  writeAuditLog: async (entry: Record<string, unknown>) => { state.audit.push(entry); return entry; },
}));

import { Prisma } from "@prisma/client";
import { createClubFormTemplate, discardClubFormDraft, getClubFormBuilderView, publishClubFormDraft, saveClubFormDraft } from "@/modules/club-forms/builder";
import { setFieldFlag, updateField, removeField, addField } from "@/components/club-form-builder-state";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { allFields, type ClubFormsViewer } from "@/modules/club-forms/domain";
import { openSensitiveAnswers, sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import { getSubmissionForViewer, saveClubFormSubmission } from "@/modules/club-forms/submissions";
import { syncClubFormTemplates } from "@/modules/club-forms/templates";
import { buildClubFormsCsv } from "@/modules/club-forms/csv";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClubFormSubmissionView } from "@/components/club-form-submission-view";
import { renameFieldKey } from "@/components/club-form-builder-state";
import type { ClubFormDraftSpec } from "@/modules/club-forms/builder-domain";

const slipSeed = clubFormTemplateSeeds.find((seed) => seed.key === "off_premises_permission_slip")!;
const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
const staff: ClubFormsViewer = { kind: "STAFF", userId: "staff-1", systemAdmin: true };

function seedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl-slip", key: slipSeed.key, name: slipSeed.name, description: slipSeed.description, version: slipSeed.version,
    definition: slipSeed.definition, sectionNotes: slipSeed.sectionNotes, sensitiveFieldKeys: slipSeed.sensitiveFieldKeys,
    birthDateFieldKeys: slipSeed.birthDateFieldKeys, staffOnlyFieldKeys: slipSeed.staffOnlyFieldKeys, hiddenFieldKeys: [],
    printLayout: slipSeed.printLayout, sortOrder: slipSeed.sortOrder, enabled: true, customizedAt: null, draft: null, draftUpdatedAt: null,
    ...overrides,
  };
}

function snapshot(row: ReturnType<typeof seedRow>) {
  return {
    templateId: row.id, version: row.version, name: row.name, description: row.description, definition: row.definition,
    sectionNotes: row.sectionNotes, sensitiveFieldKeys: row.sensitiveFieldKeys, birthDateFieldKeys: row.birthDateFieldKeys,
    staffOnlyFieldKeys: row.staffOnlyFieldKeys, hiddenFieldKeys: row.hiddenFieldKeys, printLayout: row.printLayout,
  };
}

async function currentSpec(): Promise<ClubFormDraftSpec> {
  const view = await getClubFormBuilderView(slipSeed.key);
  return view.draft ?? view.published;
}

const seedActivityLabel = allFields(registrationFormDefinitionSchema.parse(slipSeed.definition)).find((field) => field.key === "activity")!.label;
const idOf = (spec: ClubFormDraftSpec, key: string) => allFields(spec.definition).find((field) => field.key === key)!.id;

beforeEach(() => {
  state.templates.splice(0);
  state.versions.splice(0);
  state.submissions.splice(0);
  state.audit.splice(0);
  state.nextId = 1;
  const row = seedRow();
  state.templates.push(row);
  state.versions.push({ createdAt: new Date("2026-10-01T00:00:00Z"), ...snapshot(row) });
});

const now = new Date("2026-10-05T15:00:00Z");

describe("saving and publishing a draft (#712)", () => {
  it("keeps a draft off the live form until it is published, and publishing bumps the version", async () => {
    const published = await currentSpec();
    const edited = updateField(published, idOf(published, "activity"), { label: "Synthetic activity name" });
    const saved = await saveClubFormDraft(slipSeed.key, { draft: edited, baseVersion: slipSeed.version, expectedDraftUpdatedAt: null }, "admin-1", now);
    expect(saved.version).toBe(slipSeed.version);
    // Live columns untouched.
    expect(state.templates[0].version).toBe(slipSeed.version);
    expect(JSON.stringify(state.templates[0].definition)).not.toContain("Synthetic activity name");

    const result = await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    expect(result.version).toBe(slipSeed.version + 1);
    expect(state.templates[0].version).toBe(slipSeed.version + 1);
    expect(JSON.stringify(state.templates[0].definition)).toContain("Synthetic activity name");
    expect(state.templates[0].draft).toBeNull();
    // Both the old and the new version are kept.
    expect(state.versions.map((row) => row.version).sort()).toEqual([slipSeed.version, slipSeed.version + 1]);
    const oldVersion = state.versions.find((row) => row.version === slipSeed.version)!;
    expect(JSON.stringify(oldVersion.definition)).not.toContain("Synthetic activity name");
  });

  it("audits every save and publish with the actor, key and version, and never the definition", async () => {
    const published = await currentSpec();
    await saveClubFormDraft(slipSeed.key, { draft: updateField(published, idOf(published, "activity"), { label: "Synthetic label" }), baseVersion: slipSeed.version }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    expect(state.audit.map((entry) => entry.action)).toEqual(["CLUB_FORM_TEMPLATE_DRAFT_SAVED", "CLUB_FORM_TEMPLATE_PUBLISHED"]);
    expect(state.audit[0]).toMatchObject({ actorUserId: "admin-1", metadata: { templateKey: slipSeed.key, version: slipSeed.version } });
    expect(state.audit[1]).toMatchObject({ actorUserId: "admin-1", metadata: expect.objectContaining({ templateKey: slipSeed.key, version: slipSeed.version + 1 }) });
    expect(JSON.stringify(state.audit)).not.toContain("Synthetic label");
  });

  it("marks the template as edited in the app at its first publish, not at a draft save", async () => {
    const published = await currentSpec();
    await saveClubFormDraft(slipSeed.key, { draft: published, baseVersion: slipSeed.version }, "admin-1", now);
    expect(state.templates[0].customizedAt).toBeNull();
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    expect(state.templates[0].customizedAt).toEqual(now);
  });

  it("saves an unfinished draft with field-level warnings, and refuses to publish it", async () => {
    const published = await currentSpec();
    const broken = updateField(published, idOf(published, "activity"), { label: "" });
    const saved = await saveClubFormDraft(slipSeed.key, { draft: broken, baseVersion: slipSeed.version }, "admin-1", now);
    expect(saved.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ key: `field:${idOf(published, "activity")}` })]));
    expect(state.templates[0].draft).not.toBeNull();
    const error = await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ key: `field:${idOf(published, "activity")}` }] });
    expect(state.templates[0].version).toBe(slipSeed.version);
    const view = await getClubFormBuilderView(slipSeed.key);
    expect(view.draft).not.toBeNull();
    expect(view.draftWarnings.length).toBeGreaterThan(0);
  });

  it("refuses a draft that is not even structurally a draft, or is too large", async () => {
    await expect(saveClubFormDraft(slipSeed.key, { draft: { nope: true }, baseVersion: slipSeed.version }, "admin-1", now)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const published = await currentSpec();
    const huge = { ...published, description: "x".repeat(450_000) };
    await expect(saveClubFormDraft(slipSeed.key, { draft: huge, baseVersion: slipSeed.version }, "admin-1", now)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(state.templates[0].draft).toBeNull();
  });

  it("shows a stored draft that no longer parses as unreadable, and lets it be discarded", async () => {
    state.templates[0].draft = { name: 42 };
    state.templates[0].draftUpdatedAt = now;
    const view = await getClubFormBuilderView(slipSeed.key);
    expect(view.draft).toBeNull();
    expect(view.draftUnreadable).toBe(true);
    await discardClubFormDraft(slipSeed.key, "admin-1");
    expect(state.templates[0].draft).toBeNull();
    expect((await getClubFormBuilderView(slipSeed.key)).draftUnreadable).toBe(false);
  });

  it("refuses a save or publish built on a version that has since changed, or a stale draft", async () => {
    const published = await currentSpec();
    await expect(saveClubFormDraft(slipSeed.key, { draft: published, baseVersion: slipSeed.version - 1 }, "admin-1", now)).rejects.toMatchObject({ code: "TEMPLATE_CHANGED" });
    await saveClubFormDraft(slipSeed.key, { draft: published, baseVersion: slipSeed.version }, "admin-1", now);
    await expect(saveClubFormDraft(slipSeed.key, { draft: published, baseVersion: slipSeed.version, expectedDraftUpdatedAt: null }, "admin-2", now)).rejects.toMatchObject({ code: "TEMPLATE_CHANGED" });
    await expect(publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version + 5 }, "admin-1", now)).rejects.toMatchObject({ code: "TEMPLATE_CHANGED" });
  });

  it("will not publish without a saved draft", async () => {
    await expect(publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("discards a draft without changing the published version", async () => {
    const published = await currentSpec();
    await saveClubFormDraft(slipSeed.key, { draft: updateField(published, idOf(published, "activity"), { label: "Synthetic label" }), baseVersion: slipSeed.version }, "admin-1", now);
    await discardClubFormDraft(slipSeed.key, "admin-1");
    expect(state.templates[0].draft).toBeNull();
    expect(state.templates[0].version).toBe(slipSeed.version);
  });
});

describe("sensitive-flag protection on the server (#712)", () => {
  it("warns on save about a cleared sensitive flag, and refuses to publish it", async () => {
    const published = await currentSpec();
    const key = slipSeed.sensitiveFieldKeys[0];
    const loosened = setFieldFlag(published, idOf(published, key), "sensitive", false);
    const saved = await saveClubFormDraft(slipSeed.key, { draft: loosened, baseVersion: slipSeed.version }, "admin-1", now);
    expect(saved.warnings[0]).toMatchObject({ key: `field:${idOf(published, key)}` });
    await expect(publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(state.templates[0].sensitiveFieldKeys).toContain(key);
    expect(state.templates[0].version).toBe(slipSeed.version);
  });

  it("refuses to delete a sensitive field once forms exist, but allows hiding it", async () => {
    state.submissions.push({ id: "sub-1", templateId: "tpl-slip", answers: {}, sealedSensitiveAnswers: null, templateVersion: slipSeed.version });
    const published = await currentSpec();
    const key = slipSeed.sensitiveFieldKeys[0];
    const removedSave = await saveClubFormDraft(slipSeed.key, { draft: removeField(published, idOf(published, key)), baseVersion: slipSeed.version }, "admin-1", now);
    expect(removedSave.warnings).toEqual([expect.objectContaining({ key: `removed:${key}` })]);
    await expect(publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", issues: [{ key: `removed:${key}` }] });
    const stored = state.templates[0] as unknown as { draftUpdatedAt: Date };
    await saveClubFormDraft(slipSeed.key, { draft: setFieldFlag(published, idOf(published, key), "hidden", true), baseVersion: slipSeed.version, expectedDraftUpdatedAt: stored.draftUpdatedAt.toISOString() }, "admin-1", now);
    const result = await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    expect(result.version).toBe(slipSeed.version + 1);
    expect(state.templates[0].hiddenFieldKeys).toEqual([key]);
    expect(state.templates[0].sensitiveFieldKeys).toContain(key);
  });

  it("checks the protection rules again at publish, against the history as it is then", async () => {
    const published = await currentSpec();
    const key = slipSeed.sensitiveFieldKeys[0];
    // A draft saved before the field was ever sensitive in a published version cannot slip through.
    state.templates[0].draft = setFieldFlag(published, idOf(published, key), "sensitive", false);
    state.templates[0].draftUpdatedAt = now;
    await expect(publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(state.templates[0].version).toBe(slipSeed.version);
  });

  it("seals existing plain answers to a field that becomes sensitive, in the publish itself", async () => {
    const published = await currentSpec();
    const plainKey = allFields(published.definition).find((field) => !published.sensitiveFieldKeys.includes(field.key) && !published.staffOnlyFieldKeys.includes(field.key) && field.type === "TEXT")!.key;
    state.submissions.push({ id: "sub-1", templateId: "tpl-slip", answers: { [plainKey]: "Synthetic plain value" }, sealedSensitiveAnswers: null, hasSensitiveAnswers: false, templateVersion: slipSeed.version });
    await saveClubFormDraft(slipSeed.key, { draft: setFieldFlag(published, idOf(published, plainKey), "sensitive", true), baseVersion: slipSeed.version }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    const row = state.submissions[0];
    expect(row.answers).not.toHaveProperty(plainKey);
    expect(JSON.stringify(row)).not.toContain("Synthetic plain value");
    expect(openSensitiveAnswers("sub-1", row.sealedSensitiveAnswers as string)).toEqual({ [plainKey]: "Synthetic plain value" });
    // The audit row says how many, never what.
    expect(JSON.stringify(state.audit)).not.toContain("Synthetic plain value");
  });
});

describe("old submissions render against their own version (#712)", () => {
  async function publishLabelChange() {
    const published = await currentSpec();
    const edited = updateField(published, idOf(published, "activity"), { label: "Synthetic renamed activity" });
    const withNew = addField(edited, published.definition.sections[0].id);
    await saveClubFormDraft(slipSeed.key, { draft: withNew, baseVersion: slipSeed.version }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
  }

  const submitted = (version: number) => ({
    id: "sub-old", templateId: "tpl-slip", organizationId: "club-a", clubYear: "2026-27", rosterMemberId: null, subjectName: "Riley Sample",
    status: "SUBMITTED", submittedAt: now, enteredVia: "ATTENDEE", answers: { child_name: "Riley Sample", activity: "Canoe trip" },
    sealedSensitiveAnswers: sealSensitiveAnswers("sub-old", { physician_name: "Dr. Synthetic Physician" }), hasSensitiveAnswers: true, templateVersion: version,
  });

  it("shows a version 1 form with version 1's questions after version 2 is published", async () => {
    state.submissions.push(submitted(slipSeed.version));
    await publishLabelChange();
    const view = await getSubmissionForViewer(director, "sub-old");
    const labels = allFields(view.template.definition).map((field) => field.label);
    expect(labels).toContain(seedActivityLabel);
    expect(labels).not.toContain("Synthetic renamed activity");
    expect(view.template.version).toBe(slipSeed.version);
    expect(view.answers).toMatchObject({ activity: "Canoe trip", physician_name: "Dr. Synthetic Physician" });
  });

  it("shows a new form on the new version", async () => {
    await publishLabelChange();
    state.submissions.push(submitted(slipSeed.version + 1));
    const view = await getSubmissionForViewer(director, "sub-old");
    expect(allFields(view.template.definition).map((field) => field.label)).toContain("Synthetic renamed activity");
    expect(view.template.version).toBe(slipSeed.version + 1);
  });

  it("keeps restricting a key that is sensitive in the current version when an old version is shown", async () => {
    state.submissions.push(submitted(slipSeed.version));
    await publishLabelChange();
    const area: ClubFormsViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "acct-2" } };
    const view = await getSubmissionForViewer(area, "sub-old");
    expect(view.answers).not.toHaveProperty("physician_name");
    expect(JSON.stringify(view)).not.toContain("Dr. Synthetic Physician");
    expect(view.restrictedKeys).toContain("physician_name");
  });

  it("exports a column for a field that only an older version had, and no sensitive column from any version", async () => {
    state.submissions.push({ ...submitted(slipSeed.version), organization: { name: "Example Pathfinders" }, answers: { child_name: "Riley Sample", activity: "Canoe trip" } });
    const published = await currentSpec();
    // Version 2 drops the activity question (not sensitive).
    await saveClubFormDraft(slipSeed.key, { draft: removeField(published, idOf(published, "activity")), baseVersion: slipSeed.version }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    const { csv } = await buildClubFormsCsv(staff, { templateKey: slipSeed.key });
    expect(csv).toContain("Canoe trip");
    expect(csv).not.toContain("Dr. Synthetic Physician");
  });
});

describe("the sync leaves edited templates alone (#712)", () => {
  it("skips a template that was edited in the app, and reports it", async () => {
    const published = await currentSpec();
    await saveClubFormDraft(slipSeed.key, { draft: updateField(published, idOf(published, "activity"), { label: "Synthetic label" }), baseVersion: slipSeed.version }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    // The code's seed moves ahead.
    state.templates[0].version = 0;
    const before = JSON.stringify(state.templates[0]);
    const { skipped, refused } = await syncClubFormTemplates(client as never, { continueOnRefusal: true });
    expect(skipped).toEqual([{ key: slipSeed.key, reason: "edited in the app" }]);
    expect(refused).toEqual([]);
    expect(JSON.stringify(state.templates[0])).toBe(before);
    // The other seeds are still created.
    expect(state.templates.length).toBe(clubFormTemplateSeeds.length);
  });

  it("still applies a seed update when a draft is pending: the form stays fillable and the draft goes stale", async () => {
    const published = await currentSpec();
    await saveClubFormDraft(slipSeed.key, { draft: updateField(published, idOf(published, "activity"), { label: "Synthetic label" }), baseVersion: slipSeed.version }, "admin-1", now);
    expect(state.templates[0].customizedAt).toBeNull();
    expect(state.templates[0].draftBaseVersion).toBe(slipSeed.version);
    // The code's seed moves ahead of the stored version.
    state.templates[0].version = 0;
    state.templates[0].draftBaseVersion = 0;
    state.templates[0].name = "Old name";
    const result = await syncClubFormTemplates(client as never, { continueOnRefusal: true });
    expect(result.skipped).toEqual([]);
    expect(result.staleDrafts).toEqual([{ key: slipSeed.key }]);
    expect(state.templates[0].version).toBe(slipSeed.version);
    expect(state.templates[0].name).toBe(slipSeed.name);
    expect(state.templates[0].draft).not.toBeNull();
    // Fillable: nothing refuses a save for being behind the code.
    const fill = await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: slipSeed.key, answers: { child_name: "Riley Sample" }, submit: false }, now);
    expect(fill.status).toBe("DRAFT");
    const view = await getClubFormBuilderView(slipSeed.key);
    expect(view.draftStale).toBe(true);
    expect(view.draftBaseVersion).toBe(0);
  });

  it("refuses to save or publish a stale draft, and discarding it clears it", async () => {
    const published = await currentSpec();
    await saveClubFormDraft(slipSeed.key, { draft: published, baseVersion: slipSeed.version }, "admin-1", now);
    state.templates[0].draftBaseVersion = slipSeed.version - 1;
    state.templates[0].version = slipSeed.version;
    const stamp = (state.templates[0].draftUpdatedAt as Date).toISOString();
    await expect(publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now))
      .rejects.toMatchObject({ code: "TEMPLATE_CHANGED", message: expect.stringContaining("updated by a code change after this draft was started") });
    await expect(saveClubFormDraft(slipSeed.key, { draft: published, baseVersion: slipSeed.version, expectedDraftUpdatedAt: stamp }, "admin-1", now))
      .rejects.toMatchObject({ code: "TEMPLATE_CHANGED" });
    expect(state.templates[0].version).toBe(slipSeed.version);
    await discardClubFormDraft(slipSeed.key, "admin-1");
    expect(state.templates[0].draft).toBeNull();
    expect(state.templates[0].draftBaseVersion).toBeNull();
    expect((await getClubFormBuilderView(slipSeed.key)).draftStale).toBe(false);
    // A fresh draft can then be started and published.
    await saveClubFormDraft(slipSeed.key, { draft: published, baseVersion: slipSeed.version }, "admin-1", now);
    expect((await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now)).version).toBe(slipSeed.version + 1);
  });

  it("still seals keys the code seed added for a template edited in the app, without touching its definition", async () => {
    const published = await currentSpec();
    const added = slipSeed.sensitiveFieldKeys[0];
    // The app-edited template's stored list lacks a key the code now marks sensitive; an answer to it sits in plain text.
    state.templates[0].sensitiveFieldKeys = slipSeed.sensitiveFieldKeys.filter((key) => key !== added);
    state.templates[0].customizedAt = now;
    state.submissions.push({ id: "sub-1", templateId: "tpl-slip", answers: { [added]: "Synthetic plain value" }, sealedSensitiveAnswers: null, hasSensitiveAnswers: false, templateVersion: slipSeed.version });
    const definitionBefore = JSON.stringify(state.templates[0].definition);
    const { skipped } = await syncClubFormTemplates(client as never, { continueOnRefusal: true });
    expect(skipped).toEqual([{ key: slipSeed.key, reason: "edited in the app" }]);
    expect(JSON.stringify(state.templates[0].definition)).toBe(definitionBefore);
    expect(state.templates[0].sensitiveFieldKeys).toContain(added);
    const row = state.submissions[0];
    expect(JSON.stringify(row)).not.toContain("Synthetic plain value");
    expect(openSensitiveAnswers("sub-1", row.sealedSensitiveAnswers as string)).toEqual({ [added]: "Synthetic plain value" });
    expect(published.name).toBeTruthy();
  });

  it("publishing seals only keys newly sensitive against the stored list, not the seed-merged one", async () => {
    const published = await currentSpec();
    const key = slipSeed.sensitiveFieldKeys[0];
    // Stored list lacks the key (the sync has not run); the draft keeps it sensitive. Publish must seal it.
    state.templates[0].sensitiveFieldKeys = slipSeed.sensitiveFieldKeys.filter((candidate) => candidate !== key);
    state.submissions.push({ id: "sub-1", templateId: "tpl-slip", answers: { [key]: "Synthetic plain value" }, sealedSensitiveAnswers: null, hasSensitiveAnswers: false, templateVersion: slipSeed.version });
    await saveClubFormDraft(slipSeed.key, { draft: { ...published, sensitiveFieldKeys: slipSeed.sensitiveFieldKeys }, baseVersion: slipSeed.version }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    expect(JSON.stringify(state.submissions[0])).not.toContain("Synthetic plain value");
  });

  it("keeps updating a template that was never edited, and records the version it writes", async () => {
    state.templates[0].version = slipSeed.version - 1;
    state.templates[0].name = "Old name";
    const { skipped } = await syncClubFormTemplates(client as never, { continueOnRefusal: true });
    expect(skipped).toEqual([]);
    if (slipSeed.version > 1) {
      expect(state.templates[0].name).toBe(slipSeed.name);
      expect(state.versions.some((row) => row.templateId === "tpl-slip" && row.version === slipSeed.version)).toBe(true);
    }
  });
});

describe("creating and copying a form (#712)", () => {
  it("creates a blank form as a disabled, customized version 1 with a recorded version", async () => {
    const created = await createClubFormTemplate({ name: "Synthetic Skills Form" }, "admin-1", now);
    expect(created).toEqual({ key: "synthetic_skills_form", version: 1 });
    const row = state.templates.find((candidate) => candidate.key === "synthetic_skills_form")!;
    expect(row).toMatchObject({ enabled: false, version: 1, customizedAt: now });
    expect(state.versions.some((version) => version.templateId === row.id && version.version === 1)).toBe(true);
    expect(state.audit.at(-1)).toMatchObject({ action: "CLUB_FORM_TEMPLATE_CREATED", actorUserId: "admin-1", metadata: { templateKey: "synthetic_skills_form", version: 1, copiedFromKey: null } });
  });

  it("copies a template with its sections, notes and sensitive flags, disabled, under a new key", async () => {
    const created = await createClubFormTemplate({ name: "Synthetic Slip Copy", copyFromKey: slipSeed.key }, "admin-1", now);
    expect(created.key).toBe("synthetic_slip_copy");
    const copy = state.templates.find((candidate) => candidate.key === created.key)!;
    expect(copy.enabled).toBe(false);
    expect(copy.sensitiveFieldKeys).toEqual(slipSeed.sensitiveFieldKeys);
    expect(copy.sectionNotes).toEqual(slipSeed.sectionNotes);
    expect(copy.id).not.toBe("tpl-slip");
    expect(state.audit.at(-1)).toMatchObject({ metadata: { copiedFromKey: slipSeed.key } });
    // The original is not touched.
    expect(state.templates[0].version).toBe(slipSeed.version);
  });

  it("picks a free key when the name is taken, and never a seed's key", async () => {
    await createClubFormTemplate({ name: "Synthetic Skills Form" }, "admin-1", now);
    const second = await createClubFormTemplate({ name: "Synthetic Skills Form" }, "admin-1", now);
    expect(second.key).toBe("synthetic_skills_form_2");
    const seeded = await createClubFormTemplate({ name: slipSeed.key.replace(/_/g, " ") }, "admin-1", now);
    expect(seeded.key).not.toBe(slipSeed.key);
  });

  it("answers not found for a copy of a form that does not exist", async () => {
    await expect(createClubFormTemplate({ name: "Synthetic Copy", copyFromKey: "no_such_form" }, "admin-1", now)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });
});

describe("the builder view never carries answers (#712)", () => {
  it("returns definitions only", async () => {
    state.submissions.push({
      id: "sub-1", templateId: "tpl-slip", answers: { child_name: "Riley Sample" },
      sealedSensitiveAnswers: sealSensitiveAnswers("sub-1", { physician_name: "Dr. Synthetic Physician" }), templateVersion: slipSeed.version,
    });
    const view = await getClubFormBuilderView(slipSeed.key);
    expect(view.submissionCount).toBe(1);
    expect(JSON.stringify(view)).not.toContain("Riley Sample");
    expect(JSON.stringify(view)).not.toContain("Dr. Synthetic Physician");
    expect(view.lockedSensitiveKeys).toEqual(expect.arrayContaining(slipSeed.sensitiveFieldKeys));
  });
});

describe("hidden fields on every new-fill path (#712)", () => {
  async function hide(keys: string[]) {
    let spec = await currentSpec();
    for (const key of keys) spec = setFieldFlag(spec, idOf(spec, key), "hidden", true);
    const base = (await getClubFormBuilderView(slipSeed.key)).version;
    await saveClubFormDraft(slipSeed.key, { draft: spec, baseVersion: base }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: base }, "admin-1", now);
  }
  const fillAnswers = { child_name: "Riley Sample", street: "6 Example Road", city: "Exampleville", state: "IA", zip: "50001", phone: "555-0110", activity_date: "2026-11-07", ride_with: "Pat Sample", parent_signature: "Pat Sample", parent_signature_date: "2026-10-30", relationship: "Parent", emergency_contact_phone: "555-0111" };
  const draftRow = () => ({
    id: "sub-d", templateId: "tpl-slip", organizationId: "club-a", clubYear: "2026-27", rosterMemberId: null, subjectName: "Riley Sample",
    status: "DRAFT", submittedAt: null, enteredVia: "ATTENDEE", answers: { child_name: "Riley Sample", activity: "Canoe trip" },
    sealedSensitiveAnswers: sealSensitiveAnswers("sub-d", { physician_name: "Dr. Synthetic Physician" }), hasSensitiveAnswers: true, templateVersion: slipSeed.version,
  });

  it("does not require or take an answer to a hidden field when a director fills in a new form", async () => {
    await hide(["activity", "physician_name"]);
    const saved = await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: slipSeed.key, answers: { ...fillAnswers, activity: "Hand-sent value", physician_name: "Dr. Hand Sent" }, submit: true }, now);
    const row = state.submissions.find((candidate) => candidate.id === saved.id)!;
    expect(JSON.stringify(row)).not.toContain("Hand-sent value");
    expect(JSON.stringify(row)).not.toContain("Dr. Hand Sent");
    expect(openSensitiveAnswers(saved.id, row.sealedSensitiveAnswers as string)).not.toHaveProperty("physician_name");
  });

  it("offers a draft being edited only the fields the form still shows, and never returns answers to the others", async () => {
    state.submissions.push(draftRow());
    await hide(["activity", "physician_name"]);
    const view = await getSubmissionForViewer(director, "sub-d", "EDIT");
    const keys = allFields(view.template.definition).map((field) => field.key);
    expect(keys).not.toContain("activity");
    expect(keys).not.toContain("physician_name");
    expect(view.answers).toEqual({ child_name: "Riley Sample" });
    expect(JSON.stringify(view)).not.toContain("Canoe trip");
    expect(JSON.stringify(view)).not.toContain("Dr. Synthetic Physician");
  });

  it("keeps the stored plain and sealed answers to a hidden field when the draft is saved again", async () => {
    state.submissions.push(draftRow());
    await hide(["activity", "physician_name"]);
    await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: slipSeed.key, submissionId: "sub-d", answers: { child_name: "Riley Sample", street: "7 Example Road" }, submit: false }, now);
    const row = state.submissions.find((candidate) => candidate.id === "sub-d")!;
    expect(row.answers).toMatchObject({ child_name: "Riley Sample", street: "7 Example Road", activity: "Canoe trip" });
    expect(openSensitiveAnswers("sub-d", row.sealedSensitiveAnswers as string)).toEqual({ physician_name: "Dr. Synthetic Physician" });
    expect(row.hasSensitiveAnswers).toBe(true);
    expect(row.templateVersion).toBe(slipSeed.version + 1);
    // The director's own view of the saved draft (not editing) still reads them on their version... of the draft's new version.
    const view = await getSubmissionForViewer(director, "sub-d");
    expect(view.answers).toMatchObject({ activity: "Canoe trip", physician_name: "Dr. Synthetic Physician" });
  });

  it("carries answers to a removed field forward too", async () => {
    state.submissions.push(draftRow());
    let spec = await currentSpec();
    spec = removeField(spec, idOf(spec, "activity"));
    await saveClubFormDraft(slipSeed.key, { draft: spec, baseVersion: slipSeed.version }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    // A plain field with no sealed history can be removed; its stored answer is carried by the next save.
    await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: slipSeed.key, submissionId: "sub-d", answers: { child_name: "Riley Sample" }, submit: false }, now);
    const row = state.submissions.find((candidate) => candidate.id === "sub-d")!;
    expect(row.answers).toMatchObject({ activity: "Canoe trip" });
  });

  it("keeps a client-sent value for a hidden key from replacing the stored one on a draft re-save", async () => {
    state.submissions.push(draftRow());
    await hide(["activity", "physician_name"]);
    await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: slipSeed.key, submissionId: "sub-d", answers: { child_name: "Riley Sample", activity: "Tampered", physician_name: "Dr. Tampered" }, submit: false }, now);
    const row = state.submissions.find((candidate) => candidate.id === "sub-d")!;
    expect(row.answers).toMatchObject({ activity: "Canoe trip" });
    expect(JSON.stringify(row)).not.toContain("Tampered");
    expect(openSensitiveAnswers("sub-d", row.sealedSensitiveAnswers as string)).toEqual({ physician_name: "Dr. Synthetic Physician" });
  });

  it("re-seals a carried-forward sealed key even when the stored sensitive key list no longer names it", async () => {
    state.submissions.push(draftRow());
    await hide(["physician_name"]);
    // The stored list (and the seed union) are changed under it: only the sealed blob says physician_name was sensitive.
    state.templates[0].sensitiveFieldKeys = [];
    const seedKeys = slipSeed.sensitiveFieldKeys.filter((key) => key !== "physician_name");
    void seedKeys;
    await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: slipSeed.key, submissionId: "sub-d", answers: { child_name: "Riley Sample" }, submit: false }, now);
    const row = state.submissions.find((candidate) => candidate.id === "sub-d")!;
    expect(row.answers).not.toHaveProperty("physician_name");
    expect(JSON.stringify(row.answers)).not.toContain("Dr. Synthetic Physician");
    expect(openSensitiveAnswers("sub-d", row.sealedSensitiveAnswers as string)).toMatchObject({ physician_name: "Dr. Synthetic Physician" });
  });

  it("answers SENSITIVE_UNREADABLE, not a server error, when the sealed value on a draft cannot be opened", async () => {
    state.submissions.push({ ...draftRow(), sealedSensitiveAnswers: "v1.bad.bad.bad" });
    const error = await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: slipSeed.key, submissionId: "sub-d", answers: { child_name: "Riley Sample" }, submit: false }, now).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "SENSITIVE_UNREADABLE" });
    expect(state.submissions.find((candidate) => candidate.id === "sub-d")!.sealedSensitiveAnswers).toBe("v1.bad.bad.bad");
  });

  it("omits a hidden field with no answer when a form is viewed or printed, but shows it where it has one", async () => {
    await hide(["activity"]);
    state.submissions.push({ ...draftRow(), id: "sub-new", status: "SUBMITTED", submittedAt: now, sealedSensitiveAnswers: null, hasSensitiveAnswers: false, answers: { child_name: "Riley Sample" }, templateVersion: slipSeed.version + 1 });
    state.submissions.push({ ...draftRow(), id: "sub-has", status: "SUBMITTED", submittedAt: now, sealedSensitiveAnswers: null, hasSensitiveAnswers: false, answers: { child_name: "Riley Sample", activity: "Canoe trip" }, templateVersion: slipSeed.version + 1 });
    const render = async (id: string) => renderToStaticMarkup(createElement(ClubFormSubmissionView, { submission: await getSubmissionForViewer(director, id) }));
    expect(await render("sub-new")).not.toContain(seedActivityLabel);
    expect(await render("sub-has")).toContain(seedActivityLabel);
  });
});

describe("the export formats each row by its own version (#712)", () => {
  it("uses unique headings when a key was renamed, and each row's own version of the field", async () => {
    const published = await currentSpec();
    state.submissions.push({
      id: "sub-1", templateId: "tpl-slip", organizationId: "club-a", clubYear: "2026-27", subjectName: "Riley", status: "SUBMITTED", submittedAt: now, enteredVia: "ATTENDEE",
      answers: { activity: "Canoe trip" }, templateVersion: slipSeed.version, organization: { name: "Example Pathfinders" },
    });
    const renamed = renameFieldKey(published, idOf(published, "activity"), "activity_name");
    await saveClubFormDraft(slipSeed.key, { draft: renamed, baseVersion: slipSeed.version }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    state.submissions.push({
      id: "sub-2", templateId: "tpl-slip", organizationId: "club-a", clubYear: "2026-27", subjectName: "Sam", status: "SUBMITTED", submittedAt: now, enteredVia: "ATTENDEE",
      answers: { activity_name: "Hike" }, templateVersion: slipSeed.version + 1, organization: { name: "Example Pathfinders" },
    });
    const { csv } = await buildClubFormsCsv(staff, { templateKey: slipSeed.key });
    const header = csv.split("\n")[0];
    expect(header).toContain(`${seedActivityLabel} (activity)`);
    expect(header).toContain(`${seedActivityLabel} (activity_name)`);
    const headings = header.split(",");
    expect(new Set(headings).size).toBe(headings.length);
    expect(csv).toContain("Canoe trip");
    expect(csv).toContain("Hike");
  });
});

describe("the roster setting is saved and published with the form (#721)", () => {
  const withMapping = (spec: ClubFormDraftSpec, rosterMapping: ClubFormDraftSpec["rosterMapping"]): ClubFormDraftSpec => ({ ...spec, rosterMapping });
  const safe = { enabled: false, rosterType: "YOUTH" as const, fields: { fullName: "child_name" }, guardians: [] };

  it("stores the mapping on the live template at publish, and keeps it in the draft until then", async () => {
    const published = await currentSpec();
    expect(published.rosterMapping).toBeNull();
    await saveClubFormDraft(slipSeed.key, { draft: withMapping(published, safe), baseVersion: slipSeed.version }, "admin-1", now);
    expect(state.templates[0].rosterMapping).toBeUndefined();
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    expect(state.templates[0].rosterMapping).toEqual(safe);
    expect((await currentSpec()).rosterMapping).toEqual(safe);
    // The audit row names the template and version, never the mapping or an answer.
    expect(JSON.stringify(state.audit)).not.toContain("child_name");
  });

  it("warns on save and refuses to publish a mapping onto a sensitive field", async () => {
    const published = await currentSpec();
    const unsafe = withMapping(published, { ...safe, fields: { fullName: "physician_name" } });
    const saved = await saveClubFormDraft(slipSeed.key, { draft: unsafe, baseVersion: slipSeed.version }, "admin-1", now);
    expect(saved.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ key: "rosterMapping" })]));
    const error = await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VALIDATION_FAILED", issues: expect.arrayContaining([expect.objectContaining({ key: "rosterMapping" })]) });
    expect(state.templates[0].version).toBe(slipSeed.version);
    expect(state.templates[0].rosterMapping).toBeUndefined();
  });

  it("refuses to turn the setting on for a form with no birth-date question", async () => {
    const published = await currentSpec();
    await saveClubFormDraft(slipSeed.key, { draft: withMapping(published, { ...safe, enabled: true }), baseVersion: slipSeed.version }, "admin-1", now);
    await expect(publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("starts a copy of a form without the setting", async () => {
    const published = await currentSpec();
    await saveClubFormDraft(slipSeed.key, { draft: withMapping(published, safe), baseVersion: slipSeed.version }, "admin-1", now);
    await publishClubFormDraft(slipSeed.key, { baseVersion: slipSeed.version }, "admin-1", now);
    const copy = await createClubFormTemplate({ name: "Copied slip", copyFromKey: slipSeed.key }, "admin-1", now);
    const row = state.templates.find((template) => template.key === copy.key)!;
    expect(row.rosterMapping === undefined || row.rosterMapping === Prisma.DbNull).toBe(true);
  });
});
