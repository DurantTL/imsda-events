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
    const snapshot = JSON.stringify({ t: state.templates, v: state.versions, s: state.submissions, a: state.audit });
    try {
      return await work(client);
    } catch (error) {
      const restored = JSON.parse(snapshot) as { t: typeof state.templates; v: typeof state.versions; s: typeof state.submissions; a: typeof state.audit };
      state.templates.splice(0, state.templates.length, ...restored.t);
      state.versions.splice(0, state.versions.length, ...restored.v);
      state.submissions.splice(0, state.submissions.length, ...restored.s);
      state.audit.splice(0, state.audit.length, ...restored.a);
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
  clubFormSubmission: {
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
import { getSubmissionForViewer } from "@/modules/club-forms/submissions";
import { syncClubFormTemplates } from "@/modules/club-forms/templates";
import { buildClubFormsCsv } from "@/modules/club-forms/csv";
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

  it("marks the template as edited in the app on the first save", async () => {
    const published = await currentSpec();
    await saveClubFormDraft(slipSeed.key, { draft: published, baseVersion: slipSeed.version }, "admin-1", now);
    expect(state.templates[0].customizedAt).toEqual(now);
  });

  it("refuses an invalid draft with field-level issues and stores nothing", async () => {
    const published = await currentSpec();
    const broken = updateField(published, idOf(published, "activity"), { label: "" });
    const error = await saveClubFormDraft(slipSeed.key, { draft: broken, baseVersion: slipSeed.version }, "admin-1", now).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ key: `field:${idOf(published, "activity")}` }] });
    expect(state.templates[0].draft).toBeNull();
    expect(state.audit).toEqual([]);
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
  it("refuses a save that clears a sensitive flag", async () => {
    const published = await currentSpec();
    const key = slipSeed.sensitiveFieldKeys[0];
    const loosened = setFieldFlag(published, idOf(published, key), "sensitive", false);
    await expect(saveClubFormDraft(slipSeed.key, { draft: loosened, baseVersion: slipSeed.version }, "admin-1", now)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(state.templates[0].draft).toBeNull();
  });

  it("refuses to delete a sensitive field once forms exist, but allows hiding it", async () => {
    state.submissions.push({ id: "sub-1", templateId: "tpl-slip", answers: {}, sealedSensitiveAnswers: null, templateVersion: slipSeed.version });
    const published = await currentSpec();
    const key = slipSeed.sensitiveFieldKeys[0];
    await expect(saveClubFormDraft(slipSeed.key, { draft: removeField(published, idOf(published, key)), baseVersion: slipSeed.version }, "admin-1", now))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", issues: [{ key: `removed:${key}` }] });
    await saveClubFormDraft(slipSeed.key, { draft: setFieldFlag(published, idOf(published, key), "hidden", true), baseVersion: slipSeed.version }, "admin-1", now);
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
